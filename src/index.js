
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
//import { setServers } from 'dns';

// Set DNS to use Google's DNS servers to resolve MongoDB Atlas
//setServers(['8.8.8.8', '8.8.4.4']);

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
import listingCompletionsRoutes from './routes/listingCompletions.js';

import ebayRoutes from './routes/ebay.js';
import sellersRoutes from './routes/sellers.js';
import employeeProfilesRoutes from './routes/employeeProfiles.js';
import storeWiseTasksRoutes from './routes/storeWiseTasks.js';
import listerInfoRoutes from './routes/listerInfo.js';

import amazonAccountRoutes from './routes/amazonAccounts.js';
import rangeAnalysisRoutes from './routes/rangeAnalysis.js';
import ideasRoutes from './routes/ideas.js';
import ordersRoutes from './routes/orders.js';
import uploadRoutes from './routes/upload.js';
import creditCardRoutes from './routes/creditCards.js';
import creditCardNameRoutes from './routes/creditCardNames.js';
import exchangeRatesRoutes from './routes/exchangeRates.js';
import internalMessagesRoutes from './routes/internalMessages.js';
import payoneerRoutes from './routes/payoneer.js';
import paymentAccountRoutes from './routes/paymentAccounts.js';
import transactionRoutes from './routes/transactions.js';
import bankAccountRoutes from './routes/bankAccounts.js';
import columnPresetRoutes from './routes/columnPresets.js';
import amazonLookupRoutes from './routes/amazonLookup.js';
import productUmbrellaRoutes from './routes/productUmbrellas.js';
import customColumnsRoutes from './routes/customColumns.js';
import listingTemplateRoutes from './routes/listingTemplates.js';
import templateListingsRoutes from './routes/templateListings.js';
import templateOverridesRoutes from './routes/templateOverrides.js';
import sellerPricingConfigRoutes from './routes/sellerPricingConfig.js';
import accountHealthRoutes from './routes/accountHealth.js';
import chatTemplatesRoutes from './routes/chatTemplates.js';
import remarkTemplatesRoutes from './routes/remarkTemplates.js';
import extraExpensesRoutes from './routes/extraExpenses.js';

import announcementsRoutes from './routes/announcements.js';
import leavesRoutes from './routes/leaves.js';



import asinDirectoryRoutes from './routes/asinDirectory.js';
import attendanceRoutes from './routes/attendance.js';
import { initializeScheduledJobs } from './scheduledJobs.js';

const app = express();

app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));
app.use(express.json({ limit: '10mb' })); // Increased limit for bulk operations
app.use(morgan('dev'));

// Serve static uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'public/uploads')));

// Disable caching globally for all API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});



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
app.use('/api/listing-completions', listingCompletionsRoutes);

app.use('/api/ebay', ebayRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/employee-profiles', employeeProfilesRoutes);
app.use('/api/store-wise-tasks', storeWiseTasksRoutes);
app.use('/api/lister-info', listerInfoRoutes);
app.use('/api/amazon-accounts', amazonAccountRoutes);
app.use('/api/range-analysis', rangeAnalysisRoutes);
app.use('/api/ideas', ideasRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/credit-cards', creditCardRoutes);
app.use('/api/credit-card-names', creditCardNameRoutes);
app.use('/api/exchange-rates', exchangeRatesRoutes);
app.use('/api/internal-messages', internalMessagesRoutes);
app.use('/api/payoneer', payoneerRoutes);
app.use('/api/payment-accounts', paymentAccountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/column-presets', columnPresetRoutes);
app.use('/api/amazon-lookup', amazonLookupRoutes);
app.use('/api/product-umbrellas', productUmbrellaRoutes);
app.use('/api/custom-columns', customColumnsRoutes);
app.use('/api/listing-templates', listingTemplateRoutes);
app.use('/api/template-listings', templateListingsRoutes);
app.use('/api/template-overrides', templateOverridesRoutes);
app.use('/api/seller-pricing-config', sellerPricingConfigRoutes);
app.use('/api/account-health', accountHealthRoutes);
app.use('/api/chat-templates', chatTemplatesRoutes);
app.use('/api/remark-templates', remarkTemplatesRoutes);
app.use('/api/extra-expenses', extraExpensesRoutes);
app.use('/api/leaves', leavesRoutes);


app.use('/api/asin-directory', asinDirectoryRoutes);
// Nomenclature note:
// `/api/attendance` is a legacy endpoint name kept for compatibility;
// it serves working-hours tracking behavior (timer sessions), not traditional attendance management.
app.use('/api/attendance', attendanceRoutes);


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
      console.error('Failed to create sparse unique index on email:', e?.message || e);
    }

    // Initialize scheduled jobs (e.g., daily timer auto-stop)
    initializeScheduledJobs();

    app.listen(port, () => {
      console.log(`API listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });
