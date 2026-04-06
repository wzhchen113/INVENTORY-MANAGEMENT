// src/data/seed.ts
import {
  User, Store, InventoryItem, Recipe, Vendor,
  WasteEntry, AuditEvent, PrepRecipe,
  EODSubmission,
} from '../types';

export const STORES: Store[] = [
  { id: 's1', name: 'Towson', address: '1234 York Rd, Towson MD 21204', status: 'active' },
  { id: 's2', name: 'Baltimore', address: '456 Inner Harbor Blvd, Baltimore MD 21201', status: 'active' },
];

export const USERS: User[] = [
  { id: 'u1', name: 'Admin (Owner)', email: 'admin@towson.com', role: 'admin', stores: ['s1','s2'], status: 'active', initials: 'AD', color: '#378ADD' },
  { id: 'u2', name: 'Maria Garcia', email: 'maria@towson.com', role: 'user', stores: ['s1'], status: 'active', initials: 'MG', color: '#1D9E75' },
  { id: 'u3', name: 'James Thompson', email: 'james@towson.com', role: 'user', stores: ['s1'], status: 'active', initials: 'JT', color: '#D85A30' },
  { id: 'u4', name: 'Ana Rivera', email: 'ana@baltimore.com', role: 'user', stores: ['s2'], status: 'active', initials: 'AR', color: '#D4537E' },
];

export const INVENTORY: InventoryItem[] = [
  // Protein
  { id: 'i1', name: 'Beef Patty', category: 'Protein', unit: 'each', costPerUnit: 2.5, currentStock: 200, parLevel: 105, averageDailyUsage: 30, safetyStock: 15, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 200, storeId: 's1' },
  { id: 'i2', name: 'Chicken Nuggets', category: 'Protein', unit: 'each', costPerUnit: 0.25, currentStock: 300, parLevel: 170, averageDailyUsage: 50, safetyStock: 20, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 300, storeId: 's1' },
  { id: 'i3', name: 'Chicken Tenders', category: 'Protein', unit: 'each', costPerUnit: 1.2, currentStock: 150, parLevel: 85, averageDailyUsage: 25, safetyStock: 10, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 150, storeId: 's1' },
  { id: 'i4', name: 'Chicken Wings', category: 'Protein', unit: 'lbs', costPerUnit: 3.8, currentStock: 80, parLevel: 41, averageDailyUsage: 12, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 80, storeId: 's1' },
  { id: 'i5', name: 'Chicken Wings (10pc)', category: 'Protein', unit: 'each', costPerUnit: 7.0, currentStock: 40, parLevel: 41, averageDailyUsage: 12, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i6', name: 'Chicken Wings (20pc)', category: 'Protein', unit: 'each', costPerUnit: 13.0, currentStock: 20, parLevel: 41, averageDailyUsage: 12, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i7', name: 'Chicken Wings (6pc)', category: 'Protein', unit: 'each', costPerUnit: 4.5, currentStock: 60, parLevel: 41, averageDailyUsage: 12, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  { id: 'i8', name: 'Fried Chicken Breast', category: 'Protein', unit: 'each', costPerUnit: 2.8, currentStock: 80, parLevel: 50, averageDailyUsage: 15, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 80, storeId: 's1' },
  { id: 'i9', name: 'Grilled Chicken', category: 'Protein', unit: 'lbs', costPerUnit: 5.5, currentStock: 60, parLevel: 34, averageDailyUsage: 10, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  { id: 'i10', name: 'Grilled Steak', category: 'Protein', unit: 'lbs', costPerUnit: 12.0, currentStock: 30, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 30, storeId: 's1' },
  { id: 'i11', name: 'Gyro Meat (Lamb/Beef)', category: 'Protein', unit: 'lbs', costPerUnit: 8.5, currentStock: 40, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i12', name: 'Sausage', category: 'Protein', unit: 'each', costPerUnit: 1.5, currentStock: 50, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 50, storeId: 's1' },
  { id: 'i13', name: 'Shaved Chicken', category: 'Protein', unit: 'lbs', costPerUnit: 5.0, currentStock: 40, parLevel: 24, averageDailyUsage: 7, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i14', name: 'Shaved Steak', category: 'Protein', unit: 'lbs', costPerUnit: 9.0, currentStock: 40, parLevel: 24, averageDailyUsage: 7, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i15', name: 'Spicy Fried Chicken Breast', category: 'Protein', unit: 'each', costPerUnit: 3.0, currentStock: 60, parLevel: 50, averageDailyUsage: 15, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  // Seafood
  { id: 'i16', name: 'Crabmeat', category: 'Seafood', unit: 'lbs', costPerUnit: 18.0, currentStock: 15, parLevel: 11, averageDailyUsage: 3, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i17', name: 'Fried Shrimp', category: 'Seafood', unit: 'lbs', costPerUnit: 10.0, currentStock: 30, parLevel: 21, averageDailyUsage: 6, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 30, storeId: 's1' },
  { id: 'i18', name: 'Grilled Shrimp', category: 'Seafood', unit: 'lbs', costPerUnit: 11.0, currentStock: 25, parLevel: 17, averageDailyUsage: 5, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 25, storeId: 's1' },
  { id: 'i19', name: 'Shrimp (Head Off)', category: 'Seafood', unit: 'lbs', costPerUnit: 9.5, currentStock: 20, parLevel: 14, averageDailyUsage: 4, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i20', name: 'Snow Crab Legs', category: 'Seafood', unit: 'lbs', costPerUnit: 22.0, currentStock: 15, parLevel: 11, averageDailyUsage: 3, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i21', name: 'Whiting Fish Fillet', category: 'Seafood', unit: 'each', costPerUnit: 2.0, currentStock: 60, parLevel: 34, averageDailyUsage: 10, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  // Produce
  { id: 'i22', name: 'Coleslaw', category: 'Produce', unit: 'lbs', costPerUnit: 2.5, currentStock: 20, parLevel: 14, averageDailyUsage: 4, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i23', name: 'Corn', category: 'Produce', unit: 'each', costPerUnit: 0.5, currentStock: 50, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 50, storeId: 's1' },
  { id: 'i24', name: 'Cucumber', category: 'Produce', unit: 'each', costPerUnit: 0.75, currentStock: 30, parLevel: 17, averageDailyUsage: 5, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 30, storeId: 's1' },
  { id: 'i25', name: 'Green Peppers', category: 'Produce', unit: 'each', costPerUnit: 0.8, currentStock: 40, parLevel: 21, averageDailyUsage: 6, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i26', name: 'Lettuce', category: 'Produce', unit: 'each', costPerUnit: 1.5, currentStock: 40, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i27', name: 'Mixed Greens', category: 'Produce', unit: 'lbs', costPerUnit: 4.0, currentStock: 20, parLevel: 14, averageDailyUsage: 4, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i28', name: 'Mushrooms', category: 'Produce', unit: 'lbs', costPerUnit: 3.5, currentStock: 15, parLevel: 11, averageDailyUsage: 3, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i29', name: 'Onion', category: 'Produce', unit: 'each', costPerUnit: 0.5, currentStock: 60, parLevel: 34, averageDailyUsage: 10, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  { id: 'i30', name: 'Onions', category: 'Produce', unit: 'each', costPerUnit: 0.5, currentStock: 60, parLevel: 34, averageDailyUsage: 10, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  { id: 'i31', name: 'Pickles', category: 'Produce', unit: 'each', costPerUnit: 0.15, currentStock: 200, parLevel: 100, averageDailyUsage: 30, safetyStock: 10, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 200, storeId: 's1' },
  { id: 'i32', name: 'Potato', category: 'Produce', unit: 'each', costPerUnit: 0.6, currentStock: 50, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 50, storeId: 's1' },
  { id: 'i33', name: 'Tomato', category: 'Produce', unit: 'each', costPerUnit: 0.5, currentStock: 60, parLevel: 34, averageDailyUsage: 10, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 60, storeId: 's1' },
  // Dairy
  { id: 'i34', name: 'American Cheese', category: 'Dairy', unit: 'each', costPerUnit: 0.15, currentStock: 300, parLevel: 135, averageDailyUsage: 40, safetyStock: 15, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 300, storeId: 's1' },
  { id: 'i35', name: 'Butter', category: 'Dairy', unit: 'lbs', costPerUnit: 4.5, currentStock: 15, parLevel: 7, averageDailyUsage: 2, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i36', name: 'Cheddar Cheese', category: 'Dairy', unit: 'lbs', costPerUnit: 5.8, currentStock: 15, parLevel: 11, averageDailyUsage: 3, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i37', name: 'Milk', category: 'Dairy', unit: 'gal', costPerUnit: 4.0, currentStock: 8, parLevel: 5, averageDailyUsage: 1.5, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 8, storeId: 's1' },
  { id: 'i38', name: 'Provolone Cheese', category: 'Dairy', unit: 'each', costPerUnit: 0.2, currentStock: 200, parLevel: 17, averageDailyUsage: 5, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 200, storeId: 's1' },
  { id: 'i39', name: 'Shredded Cheese', category: 'Dairy', unit: 'lbs', costPerUnit: 5.0, currentStock: 20, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  // Dry goods
  { id: 'i40', name: 'Croutons', category: 'Dry goods', unit: 'bags', costPerUnit: 3.5, currentStock: 10, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 10, storeId: 's1' },
  { id: 'i41', name: 'Elbow Pasta', category: 'Dry goods', unit: 'lbs', costPerUnit: 1.2, currentStock: 25, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 25, storeId: 's1' },
  { id: 'i42', name: 'Flour Tortilla', category: 'Dry goods', unit: 'each', costPerUnit: 0.25, currentStock: 100, parLevel: 41, averageDailyUsage: 12, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 100, storeId: 's1' },
  { id: 'i43', name: 'French Fries', category: 'Dry goods', unit: 'lbs', costPerUnit: 1.8, currentStock: 100, parLevel: 68, averageDailyUsage: 20, safetyStock: 8, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 100, storeId: 's1' },
  { id: 'i44', name: 'Frying Oil', category: 'Dry goods', unit: 'gal', costPerUnit: 12.0, currentStock: 15, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i45', name: 'Mozzarella Sticks', category: 'Dry goods', unit: 'each', costPerUnit: 0.4, currentStock: 150, parLevel: 14, averageDailyUsage: 4, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 150, storeId: 's1' },
  { id: 'i46', name: 'Onion Rings', category: 'Dry goods', unit: 'each', costPerUnit: 0.3, currentStock: 100, parLevel: 34, averageDailyUsage: 10, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 100, storeId: 's1' },
  { id: 'i47', name: 'Sweet Potato Fries', category: 'Dry goods', unit: 'lbs', costPerUnit: 3.0, currentStock: 40, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  { id: 'i48', name: 'Yellow Rice', category: 'Dry goods', unit: 'lbs', costPerUnit: 1.2, currentStock: 50, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 50, storeId: 's1' },
  // Bakery
  { id: 'i49', name: 'Burger Bun', category: 'Bakery', unit: 'each', costPerUnit: 0.4, currentStock: 120, parLevel: 100, averageDailyUsage: 30, safetyStock: 10, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 120, storeId: 's1' },
  { id: 'i50', name: 'Hoagie Roll', category: 'Bakery', unit: 'each', costPerUnit: 0.6, currentStock: 80, parLevel: 50, averageDailyUsage: 15, safetyStock: 5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 80, storeId: 's1' },
  { id: 'i51', name: 'Pita Bread', category: 'Bakery', unit: 'each', costPerUnit: 0.35, currentStock: 100, parLevel: 28, averageDailyUsage: 8, safetyStock: 4, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 100, storeId: 's1' },
  // Condiments
  { id: 'i52', name: '2AM Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.2, currentStock: 256, parLevel: 14, averageDailyUsage: 4, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 256, storeId: 's1' },
  { id: 'i53', name: 'BBQ Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.1, currentStock: 128, parLevel: 11, averageDailyUsage: 3, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 128, storeId: 's1' },
  { id: 'i54', name: 'Boil Seasoning', category: 'Condiments', unit: 'oz', costPerUnit: 0.3, currentStock: 64, parLevel: 3, averageDailyUsage: 1, safetyStock: 0.5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 64, storeId: 's1' },
  { id: 'i55', name: 'Cajun Seasoning', category: 'Condiments', unit: 'oz', costPerUnit: 0.25, currentStock: 64, parLevel: 3, averageDailyUsage: 1, safetyStock: 0.5, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 64, storeId: 's1' },
  { id: 'i56', name: 'Cocktail Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.15, currentStock: 64, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 64, storeId: 's1' },
  { id: 'i57', name: 'Dipping Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.12, currentStock: 128, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 128, storeId: 's1' },
  { id: 'i58', name: 'Garlic Butter', category: 'Condiments', unit: 'oz', costPerUnit: 0.25, currentStock: 64, parLevel: 7, averageDailyUsage: 2, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 64, storeId: 's1' },
  { id: 'i59', name: 'Honey Mustard', category: 'Condiments', unit: 'oz', costPerUnit: 0.12, currentStock: 64, parLevel: 7, averageDailyUsage: 2, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 64, storeId: 's1' },
  { id: 'i60', name: 'Hot Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.08, currentStock: 128, parLevel: 4, averageDailyUsage: 1, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 128, storeId: 's1' },
  { id: 'i61', name: 'Ketchup', category: 'Condiments', unit: 'oz', costPerUnit: 0.06, currentStock: 256, parLevel: 10, averageDailyUsage: 3, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 256, storeId: 's1' },
  { id: 'i62', name: 'Mayo', category: 'Condiments', unit: 'oz', costPerUnit: 0.08, currentStock: 256, parLevel: 7, averageDailyUsage: 2, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 256, storeId: 's1' },
  { id: 'i63', name: 'Ranch Dressing', category: 'Condiments', unit: 'oz', costPerUnit: 0.12, currentStock: 128, parLevel: 10, averageDailyUsage: 3, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 128, storeId: 's1' },
  { id: 'i64', name: 'Salad Dressing', category: 'Condiments', unit: 'oz', costPerUnit: 0.12, currentStock: 128, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 128, storeId: 's1' },
  { id: 'i65', name: 'Tartar Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.15, currentStock: 64, parLevel: 4, averageDailyUsage: 1, safetyStock: 1, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 64, storeId: 's1' },
  { id: 'i66', name: 'White Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.1, currentStock: 256, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 256, storeId: 's1' },
  { id: 'i67', name: 'Wing Sauce', category: 'Condiments', unit: 'oz', costPerUnit: 0.12, currentStock: 128, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 128, storeId: 's1' },
  // Drinks
  { id: 'i68', name: 'Bottled Water', category: 'Drinks', unit: 'each', costPerUnit: 0.5, currentStock: 100, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 100, storeId: 's1' },
  { id: 'i69', name: 'Can Soda', category: 'Drinks', unit: 'each', costPerUnit: 0.6, currentStock: 150, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 150, storeId: 's1' },
  { id: 'i70', name: 'Iced Tea', category: 'Drinks', unit: 'each', costPerUnit: 0.4, currentStock: 80, parLevel: 21, averageDailyUsage: 6, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 80, storeId: 's1' },
  { id: 'i71', name: 'Lemonade', category: 'Drinks', unit: 'each', costPerUnit: 0.45, currentStock: 80, parLevel: 27, averageDailyUsage: 8, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 80, storeId: 's1' },
  // Desserts
  { id: 'i72', name: 'Cheesecake Slice', category: 'Desserts', unit: 'each', costPerUnit: 3.5, currentStock: 20, parLevel: 11, averageDailyUsage: 3, safetyStock: 2, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i73', name: 'Chocolate Cake Slice', category: 'Desserts', unit: 'each', costPerUnit: 3.0, currentStock: 20, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i74', name: 'Creme Brulee', category: 'Desserts', unit: 'each', costPerUnit: 4.5, currentStock: 15, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
  { id: 'i75', name: 'Tres Leches Cake', category: 'Desserts', unit: 'each', costPerUnit: 4.0, currentStock: 15, parLevel: 18, averageDailyUsage: 5, safetyStock: 3, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 15, storeId: 's1' },
];

export const PREP_RECIPES: PrepRecipe[] = [];

export const RECIPES: Recipe[] = [
  {
    id: 'r1', menuItem: '2AM Cheeseburger', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i1', itemName: 'Beef Patty', quantity: 1, unit: 'each' },
      { itemId: 'i49', itemName: 'Burger Bun', quantity: 1, unit: 'each' },
      { itemId: 'i34', itemName: 'American Cheese', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i31', itemName: 'Pickles', quantity: 1, unit: 'each' },
      { itemId: 'i61', itemName: 'Ketchup', quantity: 1, unit: 'oz' },
      { itemId: 'i62', itemName: 'Mayo', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r2', menuItem: 'Philly Cheesesteak', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i14', itemName: 'Shaved Steak', quantity: 1, unit: 'lbs' },
      { itemId: 'i50', itemName: 'Hoagie Roll', quantity: 1, unit: 'each' },
      { itemId: 'i38', itemName: 'Provolone Cheese', quantity: 1, unit: 'each' },
      { itemId: 'i30', itemName: 'Onions', quantity: 1, unit: 'each' },
      { itemId: 'i25', itemName: 'Green Peppers', quantity: 1, unit: 'each' },
      { itemId: 'i28', itemName: 'Mushrooms', quantity: 1, unit: 'lbs' },
      { itemId: 'i62', itemName: 'Mayo', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r3', menuItem: 'Chicken Cheesesteak', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i13', itemName: 'Shaved Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i50', itemName: 'Hoagie Roll', quantity: 1, unit: 'each' },
      { itemId: 'i38', itemName: 'Provolone Cheese', quantity: 1, unit: 'each' },
      { itemId: 'i30', itemName: 'Onions', quantity: 1, unit: 'each' },
      { itemId: 'i25', itemName: 'Green Peppers', quantity: 1, unit: 'each' },
      { itemId: 'i28', itemName: 'Mushrooms', quantity: 1, unit: 'lbs' },
      { itemId: 'i62', itemName: 'Mayo', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r4', menuItem: 'Bird & Buried', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i8', itemName: 'Fried Chicken Breast', quantity: 1, unit: 'each' },
      { itemId: 'i49', itemName: 'Burger Bun', quantity: 1, unit: 'each' },
      { itemId: 'i31', itemName: 'Pickles', quantity: 1, unit: 'each' },
      { itemId: 'i22', itemName: 'Coleslaw', quantity: 1, unit: 'lbs' },
      { itemId: 'i52', itemName: '2AM Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r5', menuItem: 'Chicken Sandwich', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i8', itemName: 'Fried Chicken Breast', quantity: 1, unit: 'each' },
      { itemId: 'i49', itemName: 'Burger Bun', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i31', itemName: 'Pickles', quantity: 1, unit: 'each' },
      { itemId: 'i62', itemName: 'Mayo', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r6', menuItem: 'Spicy Chicken Sandwich', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i15', itemName: 'Spicy Fried Chicken Breast', quantity: 1, unit: 'each' },
      { itemId: 'i49', itemName: 'Burger Bun', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i31', itemName: 'Pickles', quantity: 1, unit: 'each' },
      { itemId: 'i62', itemName: 'Mayo', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r7', menuItem: 'Fried Fish Sandwich', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i21', itemName: 'Whiting Fish Fillet', quantity: 1, unit: 'each' },
      { itemId: 'i50', itemName: 'Hoagie Roll', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i65', itemName: 'Tartar Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r8', menuItem: 'Shrimp Po Boy', category: 'Sandwiches & Burgers', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i17', itemName: 'Fried Shrimp', quantity: 1, unit: 'lbs' },
      { itemId: 'i50', itemName: 'Hoagie Roll', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i62', itemName: 'Mayo', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r9', menuItem: 'Chicken Over Rice', category: 'Over Rice Platters', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i9', itemName: 'Grilled Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i48', itemName: 'Yellow Rice', quantity: 1, unit: 'lbs' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r10', menuItem: 'Combo Over Rice', category: 'Over Rice Platters', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i9', itemName: 'Grilled Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', quantity: 1, unit: 'lbs' },
      { itemId: 'i48', itemName: 'Yellow Rice', quantity: 1, unit: 'lbs' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r11', menuItem: 'Lamb Over Rice', category: 'Over Rice Platters', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', quantity: 1, unit: 'lbs' },
      { itemId: 'i48', itemName: 'Yellow Rice', quantity: 1, unit: 'lbs' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r12', menuItem: 'Steak Over Rice', category: 'Over Rice Platters', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i10', itemName: 'Grilled Steak', quantity: 1, unit: 'lbs' },
      { itemId: 'i48', itemName: 'Yellow Rice', quantity: 1, unit: 'lbs' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r13', menuItem: 'Shrimp Over Rice', category: 'Over Rice Platters', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i18', itemName: 'Grilled Shrimp', quantity: 1, unit: 'lbs' },
      { itemId: 'i48', itemName: 'Yellow Rice', quantity: 1, unit: 'lbs' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r14', menuItem: 'Lamb Gyro', category: 'Gyros', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', quantity: 1, unit: 'lbs' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r15', menuItem: 'Chicken Gyro', category: 'Gyros', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i9', itemName: 'Grilled Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r16', menuItem: 'Shrimp Gyro', category: 'Gyros', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i18', itemName: 'Grilled Shrimp', quantity: 1, unit: 'lbs' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r17', menuItem: 'Beef Gyro', category: 'Gyros', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', quantity: 1, unit: 'lbs' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r18', menuItem: 'Steak Gyro', category: 'Gyros', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i10', itemName: 'Grilled Steak', quantity: 1, unit: 'lbs' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r19', menuItem: 'Combo Gyro', category: 'Gyros', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i9', itemName: 'Grilled Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', quantity: 1, unit: 'lbs' },
      { itemId: 'i51', itemName: 'Pita Bread', quantity: 1, unit: 'each' },
      { itemId: 'i26', itemName: 'Lettuce', quantity: 1, unit: 'each' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r20', menuItem: 'Chicken Quesadilla', category: 'Quesadillas', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i9', itemName: 'Grilled Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i42', itemName: 'Flour Tortilla', quantity: 1, unit: 'each' },
      { itemId: 'i39', itemName: 'Shredded Cheese', quantity: 1, unit: 'lbs' },
      { itemId: 'i30', itemName: 'Onions', quantity: 1, unit: 'each' },
      { itemId: 'i25', itemName: 'Green Peppers', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r21', menuItem: 'Cheesesteak Quesadilla', category: 'Quesadillas', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i14', itemName: 'Shaved Steak', quantity: 1, unit: 'lbs' },
      { itemId: 'i42', itemName: 'Flour Tortilla', quantity: 1, unit: 'each' },
      { itemId: 'i39', itemName: 'Shredded Cheese', quantity: 1, unit: 'lbs' },
      { itemId: 'i30', itemName: 'Onions', quantity: 1, unit: 'each' },
      { itemId: 'i25', itemName: 'Green Peppers', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r22', menuItem: 'Wings', category: 'Wings & Nuggets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i4', itemName: 'Chicken Wings', quantity: 1, unit: 'lbs' },
      { itemId: 'i67', itemName: 'Wing Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r23', menuItem: '6 Wings', category: 'Wings & Nuggets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i7', itemName: 'Chicken Wings (6pc)', quantity: 1, unit: 'each' },
      { itemId: 'i67', itemName: 'Wing Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r24', menuItem: '10 Wings', category: 'Wings & Nuggets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i5', itemName: 'Chicken Wings (10pc)', quantity: 1, unit: 'each' },
      { itemId: 'i67', itemName: 'Wing Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r25', menuItem: '20 Wings', category: 'Wings & Nuggets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i6', itemName: 'Chicken Wings (20pc)', quantity: 1, unit: 'each' },
      { itemId: 'i67', itemName: 'Wing Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r26', menuItem: '2AM Nuggets', category: 'Wings & Nuggets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i2', itemName: 'Chicken Nuggets', quantity: 1, unit: 'each' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
      { itemId: 'i57', itemName: 'Dipping Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r27', menuItem: 'Triple Mix', category: 'Wings & Nuggets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i4', itemName: 'Chicken Wings', quantity: 1, unit: 'lbs' },
      { itemId: 'i45', itemName: 'Mozzarella Sticks', quantity: 1, unit: 'each' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r28', menuItem: 'Fried Shrimp Basket', category: 'Baskets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i17', itemName: 'Fried Shrimp', quantity: 1, unit: 'lbs' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i56', itemName: 'Cocktail Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r29', menuItem: 'Fried Fish Basket', category: 'Baskets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i21', itemName: 'Whiting Fish Fillet', quantity: 1, unit: 'each' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i65', itemName: 'Tartar Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r30', menuItem: 'Chicken Tender Basket', category: 'Baskets', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i3', itemName: 'Chicken Tenders', quantity: 1, unit: 'each' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i57', itemName: 'Dipping Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r31', menuItem: 'Fish & Chips', category: 'Seafood', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i21', itemName: 'Whiting Fish Fillet', quantity: 1, unit: 'each' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i65', itemName: 'Tartar Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i22', itemName: 'Coleslaw', quantity: 1, unit: 'lbs' },
      { itemId: 'i44', itemName: 'Frying Oil', quantity: 1, unit: 'gal' },
    ],
    prepItems: [],
  },
  {
    id: 'r32', menuItem: 'Surf & Turf', category: 'Seafood', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i10', itemName: 'Grilled Steak', quantity: 1, unit: 'lbs' },
      { itemId: 'i18', itemName: 'Grilled Shrimp', quantity: 1, unit: 'lbs' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i58', itemName: 'Garlic Butter', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r33', menuItem: 'Crabmeat Fries', category: 'Seafood', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i16', itemName: 'Crabmeat', quantity: 1, unit: 'lbs' },
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i52', itemName: '2AM Sauce', quantity: 1, unit: 'oz' },
      { itemId: 'i39', itemName: 'Shredded Cheese', quantity: 1, unit: 'lbs' },
    ],
    prepItems: [],
  },
  {
    id: 'r34', menuItem: 'Build-A-Catch', category: 'Seafood', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i20', itemName: 'Snow Crab Legs', quantity: 1, unit: 'lbs' },
      { itemId: 'i19', itemName: 'Shrimp (Head Off)', quantity: 1, unit: 'lbs' },
      { itemId: 'i23', itemName: 'Corn', quantity: 1, unit: 'each' },
      { itemId: 'i32', itemName: 'Potato', quantity: 1, unit: 'each' },
      { itemId: 'i12', itemName: 'Sausage', quantity: 1, unit: 'each' },
      { itemId: 'i54', itemName: 'Boil Seasoning', quantity: 1, unit: 'oz' },
      { itemId: 'i58', itemName: 'Garlic Butter', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r35', menuItem: 'Chicken Salad', category: 'Salads', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i9', itemName: 'Grilled Chicken', quantity: 1, unit: 'lbs' },
      { itemId: 'i27', itemName: 'Mixed Greens', quantity: 1, unit: 'lbs' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i24', itemName: 'Cucumber', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i40', itemName: 'Croutons', quantity: 1, unit: 'bags' },
      { itemId: 'i64', itemName: 'Salad Dressing', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r36', menuItem: 'Shrimp Salad', category: 'Salads', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i18', itemName: 'Grilled Shrimp', quantity: 1, unit: 'lbs' },
      { itemId: 'i27', itemName: 'Mixed Greens', quantity: 1, unit: 'lbs' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i24', itemName: 'Cucumber', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i40', itemName: 'Croutons', quantity: 1, unit: 'bags' },
      { itemId: 'i64', itemName: 'Salad Dressing', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r37', menuItem: 'Crabmeat Salad', category: 'Salads', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i16', itemName: 'Crabmeat', quantity: 1, unit: 'lbs' },
      { itemId: 'i27', itemName: 'Mixed Greens', quantity: 1, unit: 'lbs' },
      { itemId: 'i33', itemName: 'Tomato', quantity: 1, unit: 'each' },
      { itemId: 'i24', itemName: 'Cucumber', quantity: 1, unit: 'each' },
      { itemId: 'i29', itemName: 'Onion', quantity: 1, unit: 'each' },
      { itemId: 'i40', itemName: 'Croutons', quantity: 1, unit: 'bags' },
      { itemId: 'i64', itemName: 'Salad Dressing', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r38', menuItem: 'French Fries', category: 'Sides', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
    ],
    prepItems: [],
  },
  {
    id: 'r39', menuItem: 'Cajun Fries', category: 'Sides', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i43', itemName: 'French Fries', quantity: 1, unit: 'lbs' },
      { itemId: 'i55', itemName: 'Cajun Seasoning', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r40', menuItem: 'Sweet Potato Fries', category: 'Sides', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i47', itemName: 'Sweet Potato Fries', quantity: 1, unit: 'lbs' },
    ],
    prepItems: [],
  },
  {
    id: 'r41', menuItem: 'Onion Rings', category: 'Sides', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i46', itemName: 'Onion Rings', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r42', menuItem: 'Mozzarella Sticks', category: 'Sides', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i45', itemName: 'Mozzarella Sticks', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r43', menuItem: 'Mac N Cheese', category: 'Sides', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i41', itemName: 'Elbow Pasta', quantity: 1, unit: 'lbs' },
      { itemId: 'i36', itemName: 'Cheddar Cheese', quantity: 1, unit: 'lbs' },
      { itemId: 'i37', itemName: 'Milk', quantity: 1, unit: 'gal' },
      { itemId: 'i35', itemName: 'Butter', quantity: 1, unit: 'lbs' },
    ],
    prepItems: [],
  },
  {
    id: 'r44', menuItem: 'Half N Half Tea', category: 'Drinks', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i70', itemName: 'Iced Tea', quantity: 1, unit: 'each' },
      { itemId: 'i71', itemName: 'Lemonade', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r45', menuItem: 'Can Soda', category: 'Drinks', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i69', itemName: 'Can Soda', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r46', menuItem: 'Bottled Water', category: 'Drinks', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i68', itemName: 'Bottled Water', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r47', menuItem: 'Cheesecake Slice', category: 'Desserts', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i72', itemName: 'Cheesecake Slice', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r48', menuItem: 'Choco Cake Slice', category: 'Desserts', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i73', itemName: 'Chocolate Cake Slice', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r49', menuItem: 'Tres Leches', category: 'Desserts', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i75', itemName: 'Tres Leches Cake', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r50', menuItem: 'Cr�me Brulee', category: 'Desserts', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i74', itemName: 'Cr�me Brulee', quantity: 1, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r51', menuItem: 'Ranch', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i63', itemName: 'Ranch Dressing', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r52', menuItem: 'BBQ Sauce', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i53', itemName: 'BBQ Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r53', menuItem: 'White Sauce', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i66', itemName: 'White Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r54', menuItem: '2AM Sauce', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i52', itemName: '2AM Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r55', menuItem: 'Hot Sauce', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i60', itemName: 'Hot Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r56', menuItem: 'Tartar Sauce', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i65', itemName: 'Tartar Sauce', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r57', menuItem: 'Honey Mustard', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i59', itemName: 'Honey Mustard', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
  {
    id: 'r58', menuItem: 'Ketchup', category: 'Sauces & Extras', sellPrice: 0, storeId: 's1',
    ingredients: [
      { itemId: 'i61', itemName: 'Ketchup', quantity: 1, unit: 'oz' },
    ],
    prepItems: [],
  },
];

export const VENDORS: Vendor[] = [
  { id: 'v1', name: 'Sysco', contactName: 'Mike Torres', phone: '(410) 555-0122', email: 'mike.torres@sysco.com', accountNumber: 'SYS-4421', leadTimeDays: 1, deliveryDays: ['Tuesday', 'Friday'], categories: ['Protein', 'Dairy', 'Dry goods', 'Condiments'], lastOrderDate: '' },
  { id: 'v2', name: 'US Foods', contactName: 'Sarah Lee', phone: '(410) 555-0198', email: 'sarah.lee@usfoods.com', accountNumber: 'USF-8810', leadTimeDays: 2, deliveryDays: ['Wednesday', 'Saturday'], categories: ['Seafood', 'Protein'], lastOrderDate: '' },
  { id: 'v3', name: 'Local Farms Co.', contactName: 'Tom Greer', phone: '(443) 555-0344', email: 'tom@localfarms.com', accountNumber: 'LFC-201', leadTimeDays: 1, deliveryDays: ['Monday', 'Thursday'], categories: ['Produce', 'Bakery'], lastOrderDate: '' },
];

export const WASTE_LOG: WasteEntry[] = [
  // Towson waste — logged by Maria Garcia
  { id: 'w1', itemId: 'i1', itemName: 'Beef Patty', quantity: 8, unit: 'each', costPerUnit: 2.5, reason: 'Expired', loggedBy: 'Maria Garcia', loggedByUserId: 'u2', timestamp: '2026-04-04T21:30:00.000Z', notes: 'Past use-by date', storeId: 's1' },
  { id: 'w2', itemId: 'i9', itemName: 'Grilled Chicken', quantity: 3, unit: 'lbs', costPerUnit: 5.5, reason: 'Over-prepped', loggedBy: 'Maria Garcia', loggedByUserId: 'u2', timestamp: '2026-04-04T22:00:00.000Z', notes: 'Made too much for lunch rush', storeId: 's1' },
  { id: 'w3', itemId: 'i26', itemName: 'Lettuce', quantity: 5, unit: 'each', costPerUnit: 1.5, reason: 'Quality issue', loggedBy: 'Maria Garcia', loggedByUserId: 'u2', timestamp: '2026-04-03T21:15:00.000Z', notes: 'Wilted, not usable', storeId: 's1' },
  { id: 'w4', itemId: 'i34', itemName: 'American Cheese', quantity: 20, unit: 'each', costPerUnit: 0.15, reason: 'Dropped/spilled', loggedBy: 'James Thompson', loggedByUserId: 'u3', timestamp: '2026-04-03T19:45:00.000Z', notes: 'Dropped sleeve on floor', storeId: 's1' },
  { id: 'w5', itemId: 'i17', itemName: 'Fried Shrimp', quantity: 2, unit: 'lbs', costPerUnit: 10.0, reason: 'Expired', loggedBy: 'James Thompson', loggedByUserId: 'u3', timestamp: '2026-04-02T22:10:00.000Z', notes: 'Freezer temp spike overnight', storeId: 's1' },
  { id: 'w6', itemId: 'i4', itemName: 'Chicken Wings', quantity: 5, unit: 'lbs', costPerUnit: 3.8, reason: 'Over-prepped', loggedBy: 'Maria Garcia', loggedByUserId: 'u2', timestamp: '2026-04-02T21:30:00.000Z', notes: 'Slow Tuesday night', storeId: 's1' },
  { id: 'w7', itemId: 'i37', itemName: 'Milk', quantity: 1, unit: 'gal', costPerUnit: 4.0, reason: 'Expired', loggedBy: 'James Thompson', loggedByUserId: 'u3', timestamp: '2026-04-01T20:00:00.000Z', notes: 'Past sell-by', storeId: 's1' },
  { id: 'w8', itemId: 'i33', itemName: 'Tomato', quantity: 6, unit: 'each', costPerUnit: 0.5, reason: 'Quality issue', loggedBy: 'Maria Garcia', loggedByUserId: 'u2', timestamp: '2026-03-31T21:00:00.000Z', notes: 'Soft spots, moldy', storeId: 's1' },
  // Baltimore waste — logged by Ana Rivera
  { id: 'w9', itemId: 'i1', itemName: 'Beef Patty', quantity: 12, unit: 'each', costPerUnit: 2.5, reason: 'Expired', loggedBy: 'Ana Rivera', loggedByUserId: 'u4', timestamp: '2026-04-04T21:45:00.000Z', notes: 'End of day discard', storeId: 's2' },
  { id: 'w10', itemId: 'i20', itemName: 'Snow Crab Legs', quantity: 3, unit: 'lbs', costPerUnit: 22.0, reason: 'Quality issue', loggedBy: 'Ana Rivera', loggedByUserId: 'u4', timestamp: '2026-04-04T20:30:00.000Z', notes: 'Slight odor, discarded as precaution', storeId: 's2' },
  { id: 'w11', itemId: 'i28', itemName: 'Mushrooms', quantity: 2, unit: 'lbs', costPerUnit: 3.5, reason: 'Expired', loggedBy: 'Ana Rivera', loggedByUserId: 'u4', timestamp: '2026-04-03T22:00:00.000Z', notes: 'Slimy texture', storeId: 's2' },
  { id: 'w12', itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', quantity: 4, unit: 'lbs', costPerUnit: 8.5, reason: 'Over-prepped', loggedBy: 'Ana Rivera', loggedByUserId: 'u4', timestamp: '2026-04-02T21:15:00.000Z', notes: 'Over-sliced for lunch, slow day', storeId: 's2' },
  { id: 'w13', itemId: 'i35', itemName: 'Butter', quantity: 2, unit: 'lbs', costPerUnit: 4.5, reason: 'Dropped/spilled', loggedBy: 'Ana Rivera', loggedByUserId: 'u4', timestamp: '2026-04-01T18:30:00.000Z', notes: 'Knocked off counter', storeId: 's2' },
  { id: 'w14', itemId: 'i22', itemName: 'Coleslaw', quantity: 3, unit: 'lbs', costPerUnit: 2.5, reason: 'Expired', loggedBy: 'Ana Rivera', loggedByUserId: 'u4', timestamp: '2026-03-31T21:45:00.000Z', notes: '2 days past date', storeId: 's2' },
];

export const EOD_SUBMISSIONS: EODSubmission[] = [
  // Towson — Maria Garcia, Apr 4
  {
    id: 'eod1', date: '2026-04-04', storeId: 's1', storeName: 'Towson',
    submittedBy: 'Maria Garcia', submittedByUserId: 'u2',
    timestamp: '2026-04-04T23:05:00.000Z', itemCount: 6, status: 'submitted',
    entries: [
      { id: 'eod-i1-1', itemId: 'i1', itemName: 'Beef Patty', actualRemaining: 142, unit: 'each', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-04T23:05:00.000Z', date: '2026-04-04', storeId: 's1', notes: '' },
      { id: 'eod-i4-1', itemId: 'i4', itemName: 'Chicken Wings', actualRemaining: 38, unit: 'lbs', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-04T23:05:00.000Z', date: '2026-04-04', storeId: 's1', notes: 'Ran low during dinner rush' },
      { id: 'eod-i9-1', itemId: 'i9', itemName: 'Grilled Chicken', actualRemaining: 22, unit: 'lbs', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-04T23:05:00.000Z', date: '2026-04-04', storeId: 's1', notes: '' },
      { id: 'eod-i26-1', itemId: 'i26', itemName: 'Lettuce', actualRemaining: 18, unit: 'each', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-04T23:05:00.000Z', date: '2026-04-04', storeId: 's1', notes: '' },
      { id: 'eod-i34-1', itemId: 'i34', itemName: 'American Cheese', actualRemaining: 210, unit: 'each', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-04T23:05:00.000Z', date: '2026-04-04', storeId: 's1', notes: '' },
      { id: 'eod-i17-1', itemId: 'i17', itemName: 'Fried Shrimp', actualRemaining: 12, unit: 'lbs', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-04T23:05:00.000Z', date: '2026-04-04', storeId: 's1', notes: 'Need to reorder' },
    ],
  },
  // Towson — James Thompson, Apr 3
  {
    id: 'eod2', date: '2026-04-03', storeId: 's1', storeName: 'Towson',
    submittedBy: 'James Thompson', submittedByUserId: 'u3',
    timestamp: '2026-04-03T23:15:00.000Z', itemCount: 5, status: 'submitted',
    entries: [
      { id: 'eod-i1-2', itemId: 'i1', itemName: 'Beef Patty', actualRemaining: 158, unit: 'each', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-03T23:15:00.000Z', date: '2026-04-03', storeId: 's1', notes: '' },
      { id: 'eod-i4-2', itemId: 'i4', itemName: 'Chicken Wings', actualRemaining: 52, unit: 'lbs', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-03T23:15:00.000Z', date: '2026-04-03', storeId: 's1', notes: '' },
      { id: 'eod-i20-2', itemId: 'i20', itemName: 'Snow Crab Legs', actualRemaining: 8, unit: 'lbs', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-03T23:15:00.000Z', date: '2026-04-03', storeId: 's1', notes: 'Running low' },
      { id: 'eod-i33-2', itemId: 'i33', itemName: 'Tomato', actualRemaining: 35, unit: 'each', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-03T23:15:00.000Z', date: '2026-04-03', storeId: 's1', notes: '' },
      { id: 'eod-i37-2', itemId: 'i37', itemName: 'Milk', actualRemaining: 3, unit: 'gal', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-03T23:15:00.000Z', date: '2026-04-03', storeId: 's1', notes: 'Almost out' },
    ],
  },
  // Towson — Maria Garcia, Apr 2
  {
    id: 'eod3', date: '2026-04-02', storeId: 's1', storeName: 'Towson',
    submittedBy: 'Maria Garcia', submittedByUserId: 'u2',
    timestamp: '2026-04-02T23:00:00.000Z', itemCount: 4, status: 'submitted',
    entries: [
      { id: 'eod-i1-3', itemId: 'i1', itemName: 'Beef Patty', actualRemaining: 175, unit: 'each', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-02T23:00:00.000Z', date: '2026-04-02', storeId: 's1', notes: '' },
      { id: 'eod-i9-3', itemId: 'i9', itemName: 'Grilled Chicken', actualRemaining: 40, unit: 'lbs', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-02T23:00:00.000Z', date: '2026-04-02', storeId: 's1', notes: '' },
      { id: 'eod-i26-3', itemId: 'i26', itemName: 'Lettuce', actualRemaining: 28, unit: 'each', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-02T23:00:00.000Z', date: '2026-04-02', storeId: 's1', notes: '' },
      { id: 'eod-i34-3', itemId: 'i34', itemName: 'American Cheese', actualRemaining: 245, unit: 'each', submittedBy: 'Maria Garcia', submittedByUserId: 'u2', timestamp: '2026-04-02T23:00:00.000Z', date: '2026-04-02', storeId: 's1', notes: '' },
    ],
  },
  // Towson — James Thompson, Apr 1
  {
    id: 'eod6', date: '2026-04-01', storeId: 's1', storeName: 'Towson',
    submittedBy: 'James Thompson', submittedByUserId: 'u3',
    timestamp: '2026-04-01T22:45:00.000Z', itemCount: 3, status: 'submitted',
    entries: [
      { id: 'eod-i1-6', itemId: 'i1', itemName: 'Beef Patty', actualRemaining: 185, unit: 'each', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-01T22:45:00.000Z', date: '2026-04-01', storeId: 's1', notes: '' },
      { id: 'eod-i4-6', itemId: 'i4', itemName: 'Chicken Wings', actualRemaining: 65, unit: 'lbs', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-01T22:45:00.000Z', date: '2026-04-01', storeId: 's1', notes: '' },
      { id: 'eod-i37-6', itemId: 'i37', itemName: 'Milk', actualRemaining: 5, unit: 'gal', submittedBy: 'James Thompson', submittedByUserId: 'u3', timestamp: '2026-04-01T22:45:00.000Z', date: '2026-04-01', storeId: 's1', notes: '' },
    ],
  },
  // Baltimore — Ana Rivera, Apr 4
  {
    id: 'eod4', date: '2026-04-04', storeId: 's2', storeName: 'Baltimore',
    submittedBy: 'Ana Rivera', submittedByUserId: 'u4',
    timestamp: '2026-04-04T23:30:00.000Z', itemCount: 5, status: 'submitted',
    entries: [
      { id: 'eod-i1-4', itemId: 'i1', itemName: 'Beef Patty', actualRemaining: 120, unit: 'each', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-04T23:30:00.000Z', date: '2026-04-04', storeId: 's2', notes: '' },
      { id: 'eod-i11-4', itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', actualRemaining: 18, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-04T23:30:00.000Z', date: '2026-04-04', storeId: 's2', notes: '' },
      { id: 'eod-i20-4', itemId: 'i20', itemName: 'Snow Crab Legs', actualRemaining: 5, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-04T23:30:00.000Z', date: '2026-04-04', storeId: 's2', notes: 'Discarded 3 lbs due to quality' },
      { id: 'eod-i17-4', itemId: 'i17', itemName: 'Fried Shrimp', actualRemaining: 15, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-04T23:30:00.000Z', date: '2026-04-04', storeId: 's2', notes: '' },
      { id: 'eod-i35-4', itemId: 'i35', itemName: 'Butter', actualRemaining: 6, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-04T23:30:00.000Z', date: '2026-04-04', storeId: 's2', notes: '' },
    ],
  },
  // Baltimore — Ana Rivera, Apr 3
  {
    id: 'eod5', date: '2026-04-03', storeId: 's2', storeName: 'Baltimore',
    submittedBy: 'Ana Rivera', submittedByUserId: 'u4',
    timestamp: '2026-04-03T23:20:00.000Z', itemCount: 4, status: 'submitted',
    entries: [
      { id: 'eod-i1-5', itemId: 'i1', itemName: 'Beef Patty', actualRemaining: 148, unit: 'each', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-03T23:20:00.000Z', date: '2026-04-03', storeId: 's2', notes: '' },
      { id: 'eod-i11-5', itemId: 'i11', itemName: 'Gyro Meat (Lamb/Beef)', actualRemaining: 25, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-03T23:20:00.000Z', date: '2026-04-03', storeId: 's2', notes: '' },
      { id: 'eod-i28-5', itemId: 'i28', itemName: 'Mushrooms', actualRemaining: 4, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-03T23:20:00.000Z', date: '2026-04-03', storeId: 's2', notes: 'Getting low' },
      { id: 'eod-i22-5', itemId: 'i22', itemName: 'Coleslaw', actualRemaining: 8, unit: 'lbs', submittedBy: 'Ana Rivera', submittedByUserId: 'u4', timestamp: '2026-04-03T23:20:00.000Z', date: '2026-04-03', storeId: 's2', notes: '' },
    ],
  },
];

export const AUDIT_LOG: AuditEvent[] = [
  // Towson audit events
  { id: 'a1', timestamp: '2026-04-04T21:30:00.000Z', userId: 'u2', userName: 'Maria Garcia', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Expired logged', itemRef: 'Beef Patty', value: '8 each' },
  { id: 'a2', timestamp: '2026-04-04T22:00:00.000Z', userId: 'u2', userName: 'Maria Garcia', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Over-prepped logged', itemRef: 'Grilled Chicken', value: '3 lbs' },
  { id: 'a5', timestamp: '2026-04-03T21:15:00.000Z', userId: 'u2', userName: 'Maria Garcia', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Quality issue logged', itemRef: 'Lettuce', value: '5 each' },
  { id: 'a6', timestamp: '2026-04-03T19:45:00.000Z', userId: 'u3', userName: 'James Thompson', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Dropped/spilled logged', itemRef: 'American Cheese', value: '20 each' },
  { id: 'a9', timestamp: '2026-04-02T22:10:00.000Z', userId: 'u3', userName: 'James Thompson', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Expired logged', itemRef: 'Fried Shrimp', value: '2 lbs' },
  { id: 'a10', timestamp: '2026-04-01T15:00:00.000Z', userId: 'u1', userName: 'Admin (Owner)', userRole: 'admin', storeId: 's1', storeName: 'Towson', action: 'Item edit', detail: 'Par level updated', itemRef: 'Chicken Wings', value: '40 lbs' },
  { id: 'a11', timestamp: '2026-04-01T20:00:00.000Z', userId: 'u3', userName: 'James Thompson', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Expired logged', itemRef: 'Milk', value: '1 gal' },
  { id: 'a12', timestamp: '2026-03-31T21:00:00.000Z', userId: 'u2', userName: 'Maria Garcia', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Quality issue logged', itemRef: 'Tomato', value: '6 each' },
  { id: 'a18', timestamp: '2026-03-29T16:00:00.000Z', userId: 'u1', userName: 'Admin (Owner)', userRole: 'admin', storeId: 's1', storeName: 'Towson', action: 'Stock adjusted', detail: 'Manual stock correction', itemRef: 'Grilled Steak', value: '30 lbs' },
  // Baltimore audit events
  { id: 'a19', timestamp: '2026-04-04T21:45:00.000Z', userId: 'u4', userName: 'Ana Rivera', userRole: 'user', storeId: 's2', storeName: 'Baltimore', action: 'Waste log', detail: 'Expired logged', itemRef: 'Beef Patty', value: '12 each' },
  { id: 'a20', timestamp: '2026-04-04T20:30:00.000Z', userId: 'u4', userName: 'Ana Rivera', userRole: 'user', storeId: 's2', storeName: 'Baltimore', action: 'Waste log', detail: 'Quality issue logged', itemRef: 'Snow Crab Legs', value: '3 lbs' },
  { id: 'a23', timestamp: '2026-04-03T22:00:00.000Z', userId: 'u4', userName: 'Ana Rivera', userRole: 'user', storeId: 's2', storeName: 'Baltimore', action: 'Waste log', detail: 'Expired logged', itemRef: 'Mushrooms', value: '2 lbs' },
  { id: 'a24', timestamp: '2026-04-02T21:15:00.000Z', userId: 'u4', userName: 'Ana Rivera', userRole: 'user', storeId: 's2', storeName: 'Baltimore', action: 'Waste log', detail: 'Over-prepped logged', itemRef: 'Gyro Meat (Lamb/Beef)', value: '4 lbs' },
  { id: 'a26', timestamp: '2026-04-01T18:30:00.000Z', userId: 'u4', userName: 'Ana Rivera', userRole: 'user', storeId: 's2', storeName: 'Baltimore', action: 'Waste log', detail: 'Dropped/spilled logged', itemRef: 'Butter', value: '2 lbs' },
  { id: 'a27', timestamp: '2026-03-31T21:45:00.000Z', userId: 'u4', userName: 'Ana Rivera', userRole: 'user', storeId: 's2', storeName: 'Baltimore', action: 'Waste log', detail: 'Expired logged', itemRef: 'Coleslaw', value: '3 lbs' },
  { id: 'a30', timestamp: '2026-03-30T14:00:00.000Z', userId: 'u1', userName: 'Admin (Owner)', userRole: 'admin', storeId: 's2', storeName: 'Baltimore', action: 'Item edit', detail: 'Cost updated', itemRef: 'Snow Crab Legs', value: '$22.00/lbs' },
  { id: 'a31', timestamp: '2026-04-03T09:00:00.000Z', userId: 'u1', userName: 'Admin (Owner)', userRole: 'admin', storeId: 's2', storeName: 'Baltimore', action: 'Stock adjusted', detail: 'Manual count correction', itemRef: 'Beef Patty', value: '180 each' },
  { id: 'a32', timestamp: '2026-04-02T12:00:00.000Z', userId: 'u1', userName: 'Admin (Owner)', userRole: 'admin', storeId: 's2', storeName: 'Baltimore', action: 'Item added', detail: 'New item created', itemRef: 'Sausage', value: '50 each' },
];
