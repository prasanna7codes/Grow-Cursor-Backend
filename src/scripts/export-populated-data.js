import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Import models
import User from '../models/User.js';
import Task from '../models/Task.js';
import Platform from '../models/Platform.js';
import Store from '../models/Store.js';
import Category from '../models/Category.js';
import Subcategory from '../models/Subcategory.js';
import Range from '../models/Range.js';
import Assignment from '../models/Assignment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ADD YOUR DATABASE NAME HERE - replace 'YOUR_DATABASE_NAME' with the actual database name from Compass
const DATABASE_NAME = 'grow-cursor'; // or 'dropship' or whatever you see in Compass
const MONGO_URI = process.env.MONGO_URI || `mongodb+srv://prasannasahoo0806:pua5dRtvJRTYxvGm@cluster0.lx9jyi5.mongodb.net/${DATABASE_NAME}`;
const OUTPUT_DIR = path.resolve(__dirname, '../../../exports');

// Create output directory
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function exportPopulatedData() {
  try {
    console.log('Connecting to MongoDB Atlas...');
    console.log(`Database: ${DATABASE_NAME}`);
    await mongoose.connect(MONGO_URI);
    console.log('Connected successfully!\n');

    // Get database stats to verify connection
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log(`Found ${collections.length} collections:`, collections.map(c => c.name).join(', '));
    console.log('');

    // Export Users (no references to populate)
    console.log('Exporting Users...');
    const users = await User.find().lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'users.json'),
      JSON.stringify(users, null, 2)
    );
    console.log(`✓ Exported ${users.length} users\n`);

    // Export Platforms (no references)
    console.log('Exporting Platforms...');
    const platforms = await Platform.find().lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'platforms.json'),
      JSON.stringify(platforms, null, 2)
    );
    console.log(`✓ Exported ${platforms.length} platforms\n`);

    // Export Stores (populate platform)
    console.log('Exporting Stores...');
    const stores = await Store.find().populate('platform').lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'stores.json'),
      JSON.stringify(stores, null, 2)
    );
    console.log(`✓ Exported ${stores.length} stores\n`);

    // Export Categories (no references)
    console.log('Exporting Categories...');
    const categories = await Category.find().lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'categories.json'),
      JSON.stringify(categories, null, 2)
    );
    console.log(`✓ Exported ${categories.length} categories\n`);

    // Export Subcategories (populate category)
    console.log('Exporting Subcategories...');
    const subcategories = await Subcategory.find().populate('category').lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'subcategories.json'),
      JSON.stringify(subcategories, null, 2)
    );
    console.log(`✓ Exported ${subcategories.length} subcategories\n`);

    // Export Ranges (populate category)
    console.log('Exporting Ranges...');
    const ranges = await Range.find().populate('category').lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'ranges.json'),
      JSON.stringify(ranges, null, 2)
    );
    console.log(`✓ Exported ${ranges.length} ranges\n`);

    // Export Tasks (populate all references)
    console.log('Exporting Tasks...');
    const tasks = await Task.find()
      .populate('listingPlatform')
      .populate('store')
      .populate('range')
      .populate('category')
      .populate('subcategory')
      .populate('assignedLister', 'name email username')
      .populate('assignedBy', 'name email username')
      .populate('createdBy', 'name email username')
      .lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'tasks.json'),
      JSON.stringify(tasks, null, 2)
    );
    console.log(`✓ Exported ${tasks.length} tasks\n`);

    // Export Assignments (populate nested range in rangeQuantities)
    console.log('Exporting Assignments...');
    const assignments = await Assignment.find()
      .populate('task')
      .populate('listingPlatform')
      .populate('store')
      .populate('lister', 'name email username')
      .populate('createdBy', 'name email username')
      .populate('rangeQuantities.range') // Populate nested range field
      .lean();
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'assignments.json'),
      JSON.stringify(assignments, null, 2)
    );
    console.log(`✓ Exported ${assignments.length} assignments\n`);

    console.log('✅ All data exported successfully!');
    console.log(`📁 Files saved to: ${OUTPUT_DIR}`);
    
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error exporting data:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

exportPopulatedData();