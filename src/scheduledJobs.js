import cron from 'node-cron';
import Attendance from './models/Attendance.js';
import { runScheduledUploads } from './lib/ebayFeedUpload.js';
import { refreshDiscountAlertsCache } from './routes/discounts.js';
import {
    scheduledSyncAllSellers,
    scheduledRunAutoCompatForDate,
    scheduledSkuIndexSyncAllSellers,
    initializeSkuIndexSyncState,
    scheduledPollNewOrders,
    scheduledPollOrderUpdates,
    scheduledSyncBuyerInbox
} from './routes/ebay.js';

const RUNNER_ID = (process.env.RUNNER_ID || 'local').trim().toLowerCase();
const IS_RENDER_RUNNER = RUNNER_ID === 'render';
const IS_SKU_INDEX_RUNNER = RUNNER_ID === 'render';

const pollingJobState = {
    pollNewOrders: false,
    pollOrderUpdates: false,
    buyerChatCheckNew: false,
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runPollingJob(key, label, job) {
    if (pollingJobState[key]) {
        console.log(`[CRON] ${label} already running, skipping this polling tick.`);
        return;
    }

    pollingJobState[key] = true;
    try {
        console.log(`[CRON] ${label} starting...`);
        await job();
        console.log(`[CRON] ${label} completed.`);
    } catch (error) {
        console.error(`[CRON] ${label} error:`, error.message);
    } finally {
        pollingJobState[key] = false;
    }
}

export function initializeScheduledJobs() {
    initializeSkuIndexSyncState();

    // Auto-stop all active timers daily at 2:00 AM
    cron.schedule('0 2 * * *', async () => {
        try {
            console.log('[CRON] Running daily timer auto-stop at 2:00 AM...');

            // Find all active attendance records
            const activeRecords = await Attendance.find({ status: 'active' });

            let stoppedCount = 0;

            for (const attendance of activeRecords) {
                // Stop the last active session
                if (attendance.sessions.length > 0) {
                    const lastSession = attendance.sessions[attendance.sessions.length - 1];
                    if (!lastSession.endTime) {
                        lastSession.endTime = new Date();
                    }
                }

                attendance.status = 'completed';
                attendance.calculateTotalWorkTime();
                await attendance.save();

                stoppedCount++;
            }

            console.log(`[CRON] Auto-stopped ${stoppedCount} active timer(s)`);
        } catch (error) {
            console.error('[CRON] Error in auto-stop job:', error);
        }
    }, {
        timezone: 'Asia/Kolkata' // IST timezone
    });

    console.log('[CRON] Scheduled job initialized: Daily timer auto-stop at 2:00 AM IST');

    // Auto-upload scheduled CSVs — runs every minute
    cron.schedule('* * * * *', async () => {
        try {
            await runScheduledUploads();
        } catch (error) {
            console.error('[CRON] Error in scheduled upload job:', error);
        }
    });

    console.log('[CRON] Scheduled job initialized: Auto-upload CSV (every minute)');

    // Discount alerts cache — refresh from eBay every 12 hours. The header
    // bell and its endpoint only read this cache; user activity never
    // triggers eBay calls. Runs only on the Render runner so a local dev
    // server doesn't duplicate eBay fetches (locally the cache still
    // populates lazily on the first bell request).
    if (IS_RENDER_RUNNER) {
        cron.schedule('0 */12 * * *', async () => {
            try {
                console.log('[CRON] Refreshing discount alerts cache...');
                await refreshDiscountAlertsCache();
            } catch (error) {
                console.error('[CRON] Discount alerts cache refresh error:', error.message);
            }
        });

        // Warm once at startup so the first user doesn't wait on a cold cache
        refreshDiscountAlertsCache().catch((error) =>
            console.error('[CRON] Initial discount alerts cache warm failed:', error.message)
        );

        console.log('[CRON] Scheduled job initialized: Discount alerts cache refresh (every 12 hours, Render runner only)');
    }

    if (IS_SKU_INDEX_RUNNER) {
        // SKU Index Sync at 12:30 PM IST daily.
        // Runs only on the Render runner and processes at most 3 sellers concurrently.
        cron.schedule('30 12 * * *', async () => {
            try {
                console.log('[CRON] Scheduled SKU Index Sync starting at 12:30 PM IST...');
                await scheduledSkuIndexSyncAllSellers();
            } catch (err) {
                console.error('[CRON] Scheduled SKU Index Sync error:', err.message);
            }
        }, { timezone: 'Asia/Kolkata' });

        console.log(`[CRON] Scheduled job initialized: SKU Index Sync at 12:30 PM IST (runner: ${RUNNER_ID})`);
    } else {
        console.log(`[CRON] Skipping SKU Index Sync cron initialization for runner: ${RUNNER_ID}. Set RUNNER_ID=render to enable automatic runs.`);
    }

    if (IS_RENDER_RUNNER) {
        // Fulfillment + Buyer Chat polling every 20 minutes.
        // These mirror the manual buttons:
        // - Fulfillment Dashboard: Poll New Orders
        // - Fulfillment Dashboard: Poll Order Updates
        // - Buyer Chat: Check New
        cron.schedule('*/20 * * * *', async () => {
            await runPollingJob('pollNewOrders', 'Poll New Orders', scheduledPollNewOrders);
            await sleep(15_000);
            await runPollingJob('pollOrderUpdates', 'Poll Order Updates', scheduledPollOrderUpdates);
            await sleep(15_000);
            await runPollingJob('buyerChatCheckNew', 'Buyer Chat Check New', scheduledSyncBuyerInbox);
        }, { timezone: 'Asia/Kolkata' });

        console.log(`[CRON] Scheduled job initialized: Fulfillment and Buyer Chat polling every 20 minutes (runner: ${RUNNER_ID})`);

        // Poll All Sellers at 12:05 AM IST daily.
        // Syncs eBay listings from lastListingPolledAt up to "now" for every seller.
        // After this runs, the DB will contain the previous day's listings ready for auto-compat.
        cron.schedule('5 0 * * *', async () => {
            try {
                console.log('[CRON] Scheduled Poll All Sellers starting at 12:05 AM IST...');
                await scheduledSyncAllSellers();
            } catch (err) {
                console.error('[CRON] Scheduled Poll All Sellers error:', err.message);
            }
        }, { timezone: 'Asia/Kolkata' });

        console.log(`[CRON] Scheduled job initialized: Poll All Sellers at 12:05 AM IST (runner: ${RUNNER_ID})`);
    } else {
        console.log(`[CRON] Skipping Poll All Sellers cron initialization for runner: ${RUNNER_ID}. Set RUNNER_ID=render to enable automatic runs.`);
    }

    if (IS_RENDER_RUNNER) {
        // Run Auto-Compat for the previous IST day at 3:18 AM IST daily.
        // By 3:18 AM the 1:00 AM poll has already finished (~2h18m buffer), so all
        // previous-day listings are in the DB.
        cron.schedule('35 1 * * *', async () => {
            try {
                // Compute yesterday's date in IST (UTC+5:30 = 330 minutes offset)
                const now = new Date();
                const istNow = new Date(now.getTime() + (330 * 60 * 1000));
                const yesterdayIST = new Date(istNow.getTime() - (24 * 60 * 60 * 1000));
                const targetDate = yesterdayIST.toISOString().slice(0, 10); // "YYYY-MM-DD"
                console.log(`[CRON] Scheduled Auto-Compat for ${targetDate} starting at 3:00 AM IST...`);
                await scheduledRunAutoCompatForDate(targetDate);
            } catch (err) {
                console.error('[CRON] Scheduled Auto-Compat error:', err.message);
            }
        }, { timezone: 'Asia/Kolkata' });

        console.log(`[CRON] Scheduled job initialized: Auto-Compat Run for Date at 3:00 AM IST (runner: ${RUNNER_ID})`);
    } else {
        console.log(`[CRON] Skipping Auto-Compat cron initialization for runner: ${RUNNER_ID}. Set RUNNER_ID=render to enable automatic runs.`);
    }
}
