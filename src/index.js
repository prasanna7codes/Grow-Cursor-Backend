import './instrument.js'; // Sentry — must be first import
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';

// Load environment variables FIRST before any other imports
dotenv.config();

import { connectToDatabase } from './lib/db.js';
import User from './models/User.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import platformRoutes from './routes/platforms.js';
import storeRoutes from './routes/stores.js';
import taskRoutes from './routes/tasks.js';
import rangeRoutes from './routes/ranges.js';
import categoryRoutes from './routes/categories.js';
import subcategoryRoutes from './routes/subcategories.js';

import assignmentsRouter from './routes/assignments.js';
import compatibilityRoutes from './routes/compatibility.js';

import ebayRoutes, { resumeRunningAutoCompatibilityBatches } from './routes/ebay.js';
import bestOffersRoutes from './routes/bestOffers.js';
import discountsRoutes from './routes/discounts.js';
import sellersRoutes from './routes/sellers.js';
import employeeProfilesRoutes from './routes/employeeProfiles.js';
import amazonAccountRoutes from './routes/amazonAccounts.js';
import ideasRoutes from './routes/ideas.js';
import ordersRoutes from './routes/orders.js';
import uploadRoutes from './routes/upload.js';
import creditCardRoutes from './routes/creditCards.js';
import creditCardNameRoutes from './routes/creditCardNames.js';
import resolutionOptionsRoutes from './routes/resolutionOptions.js';
import exchangeRatesRoutes from './routes/exchangeRates.js';
import internalMessagesRoutes from './routes/internalMessages.js';
import payoneerRoutes from './routes/payoneer.js';
import microOrdersRoutes from './routes/microOrders.js';
import paymentAccountRoutes from './routes/paymentAccounts.js';
import priceChangeLogsRoutes from './routes/priceChangeLogs.js';
import transactionRoutes from './routes/transactions.js';
import bankAccountRoutes from './routes/bankAccounts.js';
import columnPresetRoutes from './routes/columnPresets.js';
import listingTemplateRoutes from './routes/listingTemplates.js';
import templateListingsRoutes from './routes/templateListings.js';
import listingOverlaysRoutes from './routes/listingOverlays.js';
import templateOverridesRoutes from './routes/templateOverrides.js';
import sellerPricingConfigRoutes from './routes/sellerPricingConfig.js';
import sellerUploadLimitsRoutes from './routes/sellerUploadLimits.js';
import accountHealthRoutes from './routes/accountHealth.js';
import chatTemplatesRoutes from './routes/chatTemplates.js';
import remarkTemplatesRoutes from './routes/remarkTemplates.js';
import extraExpensesRoutes from './routes/extraExpenses.js';
import leavesRoutes from './routes/leaves.js';
import asinDirectoryRoutes from './routes/asinDirectory.js';
import asinListCategoriesRoutes from './routes/asinListCategories.js';
import asinListRangesRoutes from './routes/asinListRanges.js';
import asinListProductsRoutes from './routes/asinListProducts.js';
import csvStorageRoutes from './routes/csvStorage.js';
import attendanceRoutes from './routes/attendance.js';
import userSellersRoutes from './routes/userSellers.js';
import userCategoryTargetsRoutes from './routes/userCategoryTargets.js';
import meetingsRoutes from './routes/meetings.js';
import salaryRoutes from './routes/salary.js';
import aiRoutes from './routes/ai.js';
import affiliateOrdersRoutes from './routes/affiliateOrders.js';
import listingStatsRoutes from './routes/listingStats.js';
import itemCategoryMapRoutes from './routes/itemCategoryMap.js';
import endListingLogsRoutes from './routes/endListingLogs.js';
import amazonStockChecksRoutes, { resumeRunningAmazonStockCheckRuns } from './routes/amazonStockChecks.js';
import featurePermissionsRoutes from './routes/featurePermissions.js';
import quantityUpdateExclusionsRoutes from './routes/quantityUpdateExclusions.js';
import { initializeScheduledJobs } from './scheduledJobs.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';
import imageCache from './lib/imageCache.js';
import * as Sentry from '@sentry/node';
import logger from './lib/logger.js';

const app = express();

// Trust the first proxy hop (required on Render/Heroku/etc. for express-rate-limit
// to correctly read the client IP from X-Forwarded-For)
app.set('trust proxy', 1);

app.use(helmet());
// CORS: allowed origins are driven by CLIENT_ORIGIN env var (comma-separated) + localhost defaults
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  ...((process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)),
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  // Every header the browser is allowed to hand to client JS must be listed
  // HERE, not with res.setHeader() in a route: setHeader REPLACES this list
  // rather than adding to it, so a route setting its own value silently hides
  // Content-Disposition and CSV downloads lose their filename.
  exposedHeaders: ['Content-Disposition', 'X-Images-Refreshed', 'X-Image-Warnings']
}));
app.use(express.json({ limit: '10mb' })); // Increased limit for bulk operations
app.use(mongoSanitize()); // Sanitize user input to prevent NoSQL injection (strips $ and . from req.body/query/params)
// Structured HTTP request logging — replaces morgan
app.use(
  morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.path === '/health', // suppress noisy health-check logs
  })
);

// Serve static uploads — browser-cacheable for 1 day (ETag enables conditional revalidation)
app.use('/uploads', express.static(path.join(process.cwd(), 'public/uploads'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
}));

// Disable caching globally for all API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Rate limiting — applied after cache-control, before route handlers
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2000,            // 2000 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 500,            // 500 write operations per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests, please slow down.' },
});
app.use('/api', generalLimiter);
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return writeLimiter(req, res, next);
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Grow – Buyer Chat API Docs',
  swaggerOptions: { persistAuthorization: true }
}));
app.get('/api-docs.json', (req, res) => res.json(swaggerSpec));;



app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/platforms', platformRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/ranges', rangeRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subcategories', subcategoryRoutes);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/compatibility', compatibilityRoutes);

app.use('/api/ebay', ebayRoutes);
app.use('/api/ebay', bestOffersRoutes);
app.use('/api/ebay', discountsRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/employee-profiles', employeeProfilesRoutes);
app.use('/api/amazon-accounts', amazonAccountRoutes);
app.use('/api/ideas', ideasRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/credit-cards', creditCardRoutes);
app.use('/api/credit-card-names', creditCardNameRoutes);
app.use('/api/resolution-options', resolutionOptionsRoutes);
app.use('/api/exchange-rates', exchangeRatesRoutes);
app.use('/api/internal-messages', internalMessagesRoutes);
app.use('/api/payoneer', payoneerRoutes);
app.use('/api/micro-orders', microOrdersRoutes);
app.use('/api/payment-accounts', paymentAccountRoutes);
app.use('/api/price-change-logs', priceChangeLogsRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/column-presets', columnPresetRoutes);
app.use('/api/listing-templates', listingTemplateRoutes);
app.use('/api/template-listings', templateListingsRoutes);
app.use('/api/listing-overlays', listingOverlaysRoutes);
app.use('/api/template-overrides', templateOverridesRoutes);
app.use('/api/seller-pricing-config', sellerPricingConfigRoutes);
app.use('/api/seller-upload-limits', sellerUploadLimitsRoutes);
app.use('/api/account-health', accountHealthRoutes);
app.use('/api/chat-templates', chatTemplatesRoutes);
app.use('/api/remark-templates', remarkTemplatesRoutes);
app.use('/api/extra-expenses', extraExpensesRoutes);
app.use('/api/leaves', leavesRoutes);
app.use('/api/asin-directory', asinDirectoryRoutes);
app.use('/api/asin-list-categories', asinListCategoriesRoutes);
app.use('/api/asin-list-ranges', asinListRangesRoutes);
app.use('/api/asin-list-products', asinListProductsRoutes);
app.use('/api/csv-storage', csvStorageRoutes);
// Nomenclature note:
// `/api/attendance` is a legacy endpoint name kept for compatibility;
// it serves working-hours tracking behavior (timer sessions), not traditional attendance management.
app.use('/api/attendance', attendanceRoutes);
app.use('/api/user-sellers', userSellersRoutes);
app.use('/api/user-category-targets', userCategoryTargetsRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/affiliate-orders', affiliateOrdersRoutes);
app.use('/api/listing-stats', listingStatsRoutes);
app.use('/api/item-category-map', itemCategoryMapRoutes);
app.use('/api/end-listing-logs', endListingLogsRoutes);
app.use('/api/amazon-stock-checks', amazonStockChecksRoutes);
app.use('/api/feature-permissions', featurePermissionsRoutes);
app.use('/api/quantity-update-exclusions', quantityUpdateExclusionsRoutes);

// ── Sentry error handler ─────────────────────────────────────────────────────
// Must be registered AFTER all routes but BEFORE the custom error handler.
// Captures exceptions and forwards them to Sentry before we format the response.
Sentry.setupExpressErrorHandler(app);

// ── Global error handler ─────────────────────────────────────────────────────
// Must be registered AFTER all routes. Catches any error passed via next(err)
// or thrown inside an asyncHandler-wrapped route.
app.use((err, req, res, _next) => {
  // CORS errors surfaced from the cors() middleware
  if (err.message?.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  if (status >= 500) {
    logger.error(`[${req.method}] ${req.path}`, { error: err.message, stack: err.stack });
  }
  return res.status(status).json({ error: message });
});

const port = process.env.PORT || 5000;

connectToDatabase()
  .then(async () => {
    // Ensure email index is sparse unique to allow multiple nulls
    try {
      // Drop existing non-sparse unique index if present
      await User.collection.dropIndex('email_1');
    } catch (e) {
      // Ignore if index does not exist
    }
    try {
      await User.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
    } catch (e) {
      logger.error('Failed to create sparse unique index on email:', { error: e?.message || e });
    }

    // Initialize scheduled jobs (e.g., daily timer auto-stop)
    initializeScheduledJobs();

    // Start image cache auto-cleanup (removes expired entries every 10 minutes)
    imageCache.startAutoCleanup();

    app.listen(port, () => {
      logger.info(`API listening on :${port}`);

      // Resume any auto-compat batches that were left 'running' due to a previous server crash/restart
      resumeRunningAutoCompatibilityBatches()
        .then((resumedBatchCount) => {
          if (resumedBatchCount > 0) {
            logger.info(`[AutoCompat] Resumed ${resumedBatchCount} running batch(es) after server restart`);
          }
        })
        .catch((e) => {
          logger.error('[AutoCompat] Failed to resume running batches:', { error: e.message });
        });

      resumeRunningAmazonStockCheckRuns()
        .then((resumedRunCount) => {
          if (resumedRunCount > 0) {
            logger.info(`[Amazon Stock Check] Resumed ${resumedRunCount} queued/running run(s) after server restart`);
          }
        })
        .catch((e) => {
          logger.error('[Amazon Stock Check] Failed to resume queued/running runs:', { error: e.message });
        });
    });
  })
  .catch((err) => {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  });
