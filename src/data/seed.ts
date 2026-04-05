// src/data/seed.ts
import {
  User, Store, InventoryItem, Recipe, Vendor,
  WasteEntry, PurchaseOrder, AuditEvent, PrepRecipe,
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
  { id: 'i1',  name: 'Chicken breast',    category: 'Protein',    unit: 'lbs',   costPerUnit: 6.20,  currentStock: 40, parLevel: 20, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.5,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 22, storeId: 's1' },
  { id: 'i2',  name: 'Ground beef 80/20', category: 'Protein',    unit: 'lbs',   costPerUnit: 6.20,  currentStock: 30, parLevel: 15, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.75, expiryDate: '', lastUpdatedBy: 'James T.', lastUpdatedAt: 'Today 4:31 PM', eodRemaining: 14, storeId: 's1' },
  // Seafood
  { id: 'i3',  name: 'Salmon fillet',     category: 'Seafood',    unit: 'lbs',   costPerUnit: 18.40, currentStock: 0,  parLevel: 8,  vendorId: 'v2', vendorName: 'US Foods',    usagePerPortion: 0.4,  expiryDate: 'Jun 16', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:15 PM', eodRemaining: 0, storeId: 's1' },
  // Produce
  { id: 'i4',  name: 'Roma tomatoes',     category: 'Produce',    unit: 'lbs',   costPerUnit: 1.80,  currentStock: 25, parLevel: 12, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.2,  expiryDate: '', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:13 PM', eodRemaining: 18, storeId: 's1' },
  { id: 'i5',  name: 'Romaine lettuce',   category: 'Produce',    unit: 'cases', costPerUnit: 14.00, currentStock: 2,  parLevel: 4,  vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.15, expiryDate: '', lastUpdatedBy: 'James T.', lastUpdatedAt: 'Today 4:33 PM', eodRemaining: 2, storeId: 's1' },
  { id: 'i6',  name: 'Yellow onions',     category: 'Produce',    unit: 'lbs',   costPerUnit: 0.90,  currentStock: 18, parLevel: 10, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.2,  expiryDate: '', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:12 PM', eodRemaining: 14, storeId: 's1' },
  { id: 'i19', name: 'Iceberg lettuce',   category: 'Produce',    unit: 'heads', costPerUnit: 1.50,  currentStock: 15, parLevel: 10, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.25, expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 12, storeId: 's1' },
  { id: 'i20', name: 'Tomato',            category: 'Produce',    unit: 'each',  costPerUnit: 0.50,  currentStock: 30, parLevel: 15, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.5,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 25, storeId: 's1' },
  { id: 'i21', name: 'Red onion',         category: 'Produce',    unit: 'each',  costPerUnit: 0.40,  currentStock: 20, parLevel: 10, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.25, expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 16, storeId: 's1' },
  { id: 'i22', name: 'Pickles',           category: 'Produce',    unit: 'gal',   costPerUnit: 6.50,  currentStock: 4,  parLevel: 2,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.02, expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 3, storeId: 's1' },
  // Dairy
  { id: 'i7',  name: 'Cheddar cheese',    category: 'Dairy',      unit: 'lbs',   costPerUnit: 5.80,  currentStock: 12, parLevel: 6,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.1,  expiryDate: '', lastUpdatedBy: 'James T.', lastUpdatedAt: 'Today 4:29 PM', eodRemaining: 9, storeId: 's1' },
  { id: 'i8',  name: 'Heavy cream',       category: 'Dairy',      unit: 'qt',    costPerUnit: 4.50,  currentStock: 3,  parLevel: 5,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.2,  expiryDate: 'Jun 15', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:14 PM', eodRemaining: 3, storeId: 's1' },
  { id: 'i13', name: 'Eggs (large)',      category: 'Dairy',      unit: 'dozen', costPerUnit: 4.20,  currentStock: 10, parLevel: 5,  vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.25, expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 7, storeId: 's1' },
  // Dry goods
  { id: 'i9',  name: 'All-purpose flour', category: 'Dry goods',  unit: 'lbs',   costPerUnit: 0.60,  currentStock: 35, parLevel: 20, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.4,  expiryDate: '', lastUpdatedBy: 'James T.', lastUpdatedAt: 'Today 4:30 PM', eodRemaining: 28, storeId: 's1' },
  { id: 'i10', name: 'Olive oil',         category: 'Dry goods',  unit: 'liters',costPerUnit: 8.20,  currentStock: 6,  parLevel: 3,  vendorId: 'v2', vendorName: 'US Foods',    usagePerPortion: 0.05, expiryDate: '', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:13 PM', eodRemaining: 5, storeId: 's1' },
  { id: 'i11', name: 'Pasta (penne)',     category: 'Dry goods',  unit: 'lbs',   costPerUnit: 1.40,  currentStock: 20, parLevel: 10, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.3,  expiryDate: '', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:14 PM', eodRemaining: 13.4, storeId: 's1' },
  { id: 'i12', name: 'Jasmine rice',      category: 'Dry goods',  unit: 'lbs',   costPerUnit: 1.20,  currentStock: 25, parLevel: 12, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.35, expiryDate: '', lastUpdatedBy: 'James T.', lastUpdatedAt: 'Today 4:32 PM', eodRemaining: 20, storeId: 's1' },
  // Bakery
  { id: 'i14', name: 'Sourdough bread',   category: 'Bakery',     unit: 'loaves',costPerUnit: 3.80,  currentStock: 2,  parLevel: 3,  vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 0.2,  expiryDate: '', lastUpdatedBy: 'James T.', lastUpdatedAt: 'Today 4:35 PM', eodRemaining: 2, storeId: 's1' },
  { id: 'i23', name: 'Hamburger buns',    category: 'Bakery',     unit: 'each',  costPerUnit: 0.45,  currentStock: 48, parLevel: 24, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 1,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 40, storeId: 's1' },
  // Produce (lemons)
  { id: 'i15', name: 'Lemon',             category: 'Produce',    unit: 'each',  costPerUnit: 0.35,  currentStock: 30, parLevel: 15, vendorId: 'v3', vendorName: 'Local Farms', usagePerPortion: 1,    expiryDate: '', lastUpdatedBy: 'Maria G.', lastUpdatedAt: 'Today 4:16 PM', eodRemaining: 22, storeId: 's1' },
  // Spices
  { id: 'i16', name: 'Black pepper',      category: 'Spices',     unit: 'oz',    costPerUnit: 0.80,  currentStock: 16, parLevel: 8,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.02, expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 14, storeId: 's1' },
  { id: 'i17', name: 'Kosher salt',       category: 'Spices',     unit: 'oz',    costPerUnit: 0.06,  currentStock: 160, parLevel: 80,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.05, expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 140, storeId: 's1' },
  { id: 'i24', name: 'Cumin',             category: 'Spices',     unit: 'oz',    costPerUnit: 0.65,  currentStock: 24, parLevel: 12, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.1,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i25', name: 'Coriander',         category: 'Spices',     unit: 'oz',    costPerUnit: 0.55,  currentStock: 24, parLevel: 12, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.1,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i26', name: 'Paprika',           category: 'Spices',     unit: 'oz',    costPerUnit: 0.50,  currentStock: 24, parLevel: 12, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.1,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 20, storeId: 's1' },
  { id: 'i27', name: 'Turmeric',          category: 'Spices',     unit: 'oz',    costPerUnit: 0.70,  currentStock: 16, parLevel: 8,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.1,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 14, storeId: 's1' },
  { id: 'i28', name: 'Cajun seasoning',   category: 'Spices',     unit: 'oz',    costPerUnit: 0.75,  currentStock: 32, parLevel: 16, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0.2,  expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 28, storeId: 's1' },
  // Seafood
  { id: 'i18', name: 'Shrimp (16-20)',    category: 'Seafood',    unit: 'lbs',   costPerUnit: 12.50, currentStock: 8,  parLevel: 5,  vendorId: 'v2', vendorName: 'US Foods',    usagePerPortion: 0.35, expiryDate: 'Jun 16', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 6, storeId: 's1' },
  // Condiments & liquids
  { id: 'i29', name: 'White vinegar',     category: 'Condiments', unit: 'oz',    costPerUnit: 0.04,  currentStock: 128, parLevel: 64, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 100, storeId: 's1' },
  { id: 'i30', name: 'Chicken stock',     category: 'Condiments', unit: 'oz',    costPerUnit: 0.12,  currentStock: 256, parLevel: 128, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 200, storeId: 's1' },
  { id: 'i31', name: 'Mayonnaise',        category: 'Condiments', unit: 'gal',   costPerUnit: 8.50,  currentStock: 6,  parLevel: 3,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 5, storeId: 's1' },
  { id: 'i32', name: 'Ketchup',           category: 'Condiments', unit: 'gal',   costPerUnit: 6.50,  currentStock: 4,  parLevel: 2,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 3, storeId: 's1' },
  { id: 'i33', name: 'Yellow mustard',    category: 'Condiments', unit: 'gal',   costPerUnit: 5.00,  currentStock: 3,  parLevel: 1,  vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 2, storeId: 's1' },
  { id: 'i34', name: 'Worcestershire',    category: 'Condiments', unit: 'oz',    costPerUnit: 0.15,  currentStock: 64, parLevel: 32, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 50, storeId: 's1' },
  { id: 'i35', name: 'Lemon juice',       category: 'Condiments', unit: 'oz',    costPerUnit: 0.08,  currentStock: 64, parLevel: 32, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 50, storeId: 's1' },
  { id: 'i36', name: 'Vegetable oil',     category: 'Dry goods',  unit: 'oz',    costPerUnit: 0.05,  currentStock: 256, parLevel: 128, vendorId: 'v1', vendorName: 'Sysco',       usagePerPortion: 0,    expiryDate: '', lastUpdatedBy: 'Admin',    lastUpdatedAt: 'Today 9:00 AM', eodRemaining: 200, storeId: 's1' },
];

export const PREP_RECIPES: PrepRecipe[] = [
  {
    id: 'pr1', name: '40lb Marinated Chicken', category: 'Marinades', yieldQuantity: 40, yieldUnit: 'lb', notes: 'Marinate overnight, 12-24 hours', storeId: 's1', createdBy: 'Admin', createdAt: 'Jun 10',
    ingredients: [
      { itemId: 'i29', itemName: 'White vinegar', quantity: 16, unit: 'oz' },
      { itemId: 'i24', itemName: 'Cumin', quantity: 8, unit: 'oz' },
      { itemId: 'i25', itemName: 'Coriander', quantity: 8, unit: 'oz' },
      { itemId: 'i26', itemName: 'Paprika', quantity: 8, unit: 'oz' },
      { itemId: 'i30', itemName: 'Chicken stock', quantity: 8, unit: 'oz' },
      { itemId: 'i17', itemName: 'Kosher salt', quantity: 4, unit: 'oz' },
      { itemId: 'i16', itemName: 'Black pepper', quantity: 8, unit: 'oz' },
    ],
  },
  {
    id: 'pr2', name: '2AM Sauce', category: 'Sauces', yieldQuantity: 3.5, yieldUnit: 'gal', notes: 'House signature sauce', storeId: 's1', createdBy: 'Admin', createdAt: 'Jun 10',
    ingredients: [
      { itemId: 'i31', itemName: 'Mayonnaise', quantity: 2, unit: 'gal' },
      { itemId: 'i32', itemName: 'Ketchup', quantity: 1, unit: 'gal' },
      { itemId: 'i33', itemName: 'Yellow mustard', quantity: 0.5, unit: 'gal' },
      { itemId: 'i28', itemName: 'Cajun seasoning', quantity: 16, unit: 'oz' },
      { itemId: 'i34', itemName: 'Worcestershire', quantity: 8, unit: 'oz' },
    ],
  },
  {
    id: 'pr3', name: '1 Pot Cooked Yellow Rice', category: 'Bases', yieldQuantity: 10, yieldUnit: 'lb', notes: 'One full hotel pan', storeId: 's1', createdBy: 'Admin', createdAt: 'Jun 10',
    ingredients: [
      { itemId: 'i35', itemName: 'Lemon juice', quantity: 4, unit: 'oz' },
      { itemId: 'i36', itemName: 'Vegetable oil', quantity: 8, unit: 'oz' },
      { itemId: 'i27', itemName: 'Turmeric', quantity: 8, unit: 'oz' },
      { itemId: 'i30', itemName: 'Chicken stock', quantity: 8, unit: 'oz' },
      { itemId: 'i25', itemName: 'Coriander', quantity: 4, unit: 'oz' },
    ],
  },
];

export const RECIPES: Recipe[] = [
  {
    id: 'r1', menuItem: 'Grilled Chicken Plate', category: 'Mains', sellPrice: 14.00, storeId: 's1',
    ingredients: [
      { itemId: 'i1', itemName: 'Chicken breast', quantity: 0.5, unit: 'lbs' },
      { itemId: 'i15', itemName: 'Lemon', quantity: 1, unit: 'each' },
      { itemId: 'i10', itemName: 'Olive oil', quantity: 0.05, unit: 'liters' },
    ],
    prepItems: [],
  },
  {
    id: 'r2', menuItem: 'Beef Burger', category: 'Mains', sellPrice: 13.00, storeId: 's1',
    ingredients: [
      { itemId: 'i2', itemName: 'Ground beef 80/20', quantity: 0.75, unit: 'lbs' },
      { itemId: 'i7', itemName: 'Cheddar cheese', quantity: 0.1, unit: 'lbs' },
      { itemId: 'i14', itemName: 'Sourdough bread', quantity: 0.2, unit: 'loaves' },
    ],
    prepItems: [],
  },
  {
    id: 'r3', menuItem: 'Caesar Salad', category: 'Salads', sellPrice: 12.00, storeId: 's1',
    ingredients: [
      { itemId: 'i5', itemName: 'Romaine lettuce', quantity: 0.15, unit: 'cases' },
      { itemId: 'i15', itemName: 'Lemon', quantity: 0.5, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r4', menuItem: 'Pasta Primavera', category: 'Mains', sellPrice: 13.00, storeId: 's1',
    ingredients: [
      { itemId: 'i11', itemName: 'Pasta (penne)', quantity: 0.3, unit: 'lbs' },
      { itemId: 'i4', itemName: 'Roma tomatoes', quantity: 0.2, unit: 'lbs' },
      { itemId: 'i10', itemName: 'Olive oil', quantity: 0.04, unit: 'liters' },
      { itemId: 'i6', itemName: 'Yellow onions', quantity: 0.1, unit: 'lbs' },
    ],
    prepItems: [],
  },
  {
    id: 'r5', menuItem: 'Salmon Plate', category: 'Mains', sellPrice: 22.00, storeId: 's1',
    ingredients: [
      { itemId: 'i3', itemName: 'Salmon fillet', quantity: 0.4, unit: 'lbs' },
      { itemId: 'i12', itemName: 'Jasmine rice', quantity: 0.3, unit: 'lbs' },
      { itemId: 'i15', itemName: 'Lemon', quantity: 2, unit: 'each' },
    ],
    prepItems: [],
  },
  {
    id: 'r6', menuItem: 'Classic Cheeseburger', category: 'Mains', sellPrice: 13.50, storeId: 's1',
    ingredients: [
      { itemId: 'i2', itemName: 'Ground beef 80/20', quantity: 0.33, unit: 'lbs' },
      { itemId: 'i7', itemName: 'Cheddar cheese', quantity: 0.1, unit: 'lbs' },
      { itemId: 'i19', itemName: 'Iceberg lettuce', quantity: 0.25, unit: 'heads' },
      { itemId: 'i20', itemName: 'Tomato', quantity: 0.5, unit: 'each' },
      { itemId: 'i21', itemName: 'Red onion', quantity: 0.25, unit: 'each' },
      { itemId: 'i22', itemName: 'Pickles', quantity: 0.02, unit: 'gal' },
      { itemId: 'i23', itemName: 'Hamburger buns', quantity: 1, unit: 'each' },
      { itemId: 'i17', itemName: 'Kosher salt', quantity: 0.5, unit: 'oz' },
      { itemId: 'i16', itemName: 'Black pepper', quantity: 0.25, unit: 'oz' },
    ],
    prepItems: [
      { prepRecipeId: 'pr2', prepRecipeName: '2AM Sauce', quantity: 2, unit: 'oz' },
    ],
  },
];

export const VENDORS: Vendor[] = [
  { id: 'v1', name: 'Sysco', contactName: 'Mike Torres', phone: '(410) 555-0122', email: 'mike.torres@sysco.com', accountNumber: 'SYS-4421', leadTimeDays: 2, categories: ['Protein', 'Dairy', 'Dry goods', 'Spices', 'Condiments'], lastOrderDate: 'Jun 10' },
  { id: 'v2', name: 'US Foods', contactName: 'Sarah Lee', phone: '(410) 555-0198', email: 'sarah.lee@usfoods.com', accountNumber: 'USF-8810', leadTimeDays: 3, categories: ['Seafood', 'Oils'], lastOrderDate: 'Jun 8' },
  { id: 'v3', name: 'Local Farms Co.', contactName: 'Tom Greer', phone: '(443) 555-0344', email: 'tom@localfarms.com', accountNumber: 'LFC-201', leadTimeDays: 1, categories: ['Produce', 'Dairy', 'Bakery'], lastOrderDate: 'Jun 11' },
];

export const WASTE_LOG: WasteEntry[] = [
  { id: 'w1', itemId: 'i3', itemName: 'Salmon fillet', quantity: 3, unit: 'lbs', costPerUnit: 18.40, reason: 'Expired', loggedBy: 'Maria G.', loggedByUserId: 'u2', timestamp: 'Jun 13 · 5:00 PM', notes: 'Missed rotation', storeId: 's1' },
  { id: 'w2', itemId: 'i8', itemName: 'Heavy cream', quantity: 2, unit: 'qt', costPerUnit: 4.50, reason: 'Expired', loggedBy: 'Admin', loggedByUserId: 'u1', timestamp: 'Jun 12 · 3:30 PM', notes: '', storeId: 's1' },
  { id: 'w3', itemId: 'i2', itemName: 'Ground beef 80/20', quantity: 1.5, unit: 'lbs', costPerUnit: 6.20, reason: 'Over-prepped', loggedBy: 'James T.', loggedByUserId: 'u3', timestamp: 'Today · 4:20 PM', notes: 'Extra batch from lunch', storeId: 's1' },
  { id: 'w4', itemId: 'i5', itemName: 'Romaine lettuce', quantity: 0.5, unit: 'cases', costPerUnit: 14.00, reason: 'Quality issue', loggedBy: 'Maria G.', loggedByUserId: 'u2', timestamp: 'Today · 4:22 PM', notes: 'Slimy leaves on delivery', storeId: 's1' },
];

export const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    id: 'po1', poNumber: 'PO-001', vendorId: 'v1', vendorName: 'Sysco',
    createdBy: 'Admin', createdByUserId: 'u1', createdAt: 'Jun 10',
    expectedDelivery: 'Jun 12', totalCost: 1140, status: 'received',
    storeId: 's1', receivedAt: 'Jun 12', receivedBy: 'Admin',
    items: [
      { itemId: 'i1', itemName: 'Chicken breast', unit: 'lbs', orderedQty: 50, receivedQty: 50, costPerUnit: 6.20 },
      { itemId: 'i2', itemName: 'Ground beef 80/20', unit: 'lbs', orderedQty: 40, receivedQty: 40, costPerUnit: 6.20 },
    ],
  },
  {
    id: 'po2', poNumber: 'PO-004', vendorId: 'v1', vendorName: 'Sysco',
    createdBy: 'Admin', createdByUserId: 'u1', createdAt: 'Jun 14',
    expectedDelivery: 'Jun 16', totalCost: 1240, status: 'sent',
    storeId: 's1',
    items: [
      { itemId: 'i1', itemName: 'Chicken breast', unit: 'lbs', orderedQty: 20, costPerUnit: 6.20 },
      { itemId: 'i2', itemName: 'Ground beef 80/20', unit: 'lbs', orderedQty: 15, costPerUnit: 6.20 },
      { itemId: 'i3', itemName: 'Salmon fillet', unit: 'lbs', orderedQty: 10, costPerUnit: 18.40 },
      { itemId: 'i7', itemName: 'Cheddar cheese', unit: 'lbs', orderedQty: 8, costPerUnit: 5.80 },
      { itemId: 'i11', itemName: 'Pasta (penne)', unit: 'lbs', orderedQty: 15, costPerUnit: 1.40 },
    ],
  },
  {
    id: 'po3', poNumber: 'PO-005', vendorId: 'v2', vendorName: 'US Foods',
    createdBy: 'Admin', createdByUserId: 'u1', createdAt: 'Jun 14',
    expectedDelivery: 'Jun 17', totalCost: 600, status: 'draft',
    storeId: 's1',
    items: [
      { itemId: 'i3', itemName: 'Salmon fillet', unit: 'lbs', orderedQty: 15, costPerUnit: 18.40 },
      { itemId: 'i18', itemName: 'Shrimp (16-20)', unit: 'lbs', orderedQty: 10, costPerUnit: 12.50 },
    ],
  },
];

export const AUDIT_LOG: AuditEvent[] = [
  { id: 'a1', timestamp: 'Jun 14 · 9:00 AM', userId: 'u1', userName: 'Admin', userRole: 'admin', storeId: 's1', storeName: 'Towson', action: 'Item edit', detail: 'Set opening stock', itemRef: 'Chicken breast', value: '40 lbs' },
  { id: 'a2', timestamp: 'Jun 14 · 9:02 AM', userId: 'u1', userName: 'Admin', userRole: 'admin', storeId: 's1', storeName: 'Towson', action: 'PO sent', detail: 'PO-004 sent to Sysco', itemRef: 'PO-004', value: '$1,240' },
  { id: 'a3', timestamp: 'Jun 14 · 4:12 PM', userId: 'u2', userName: 'Maria G.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'EOD entry', detail: 'Remaining count submitted', itemRef: 'Chicken breast', value: '22 lbs' },
  { id: 'a4', timestamp: 'Jun 14 · 4:13 PM', userId: 'u2', userName: 'Maria G.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'EOD entry', detail: 'Remaining count submitted', itemRef: 'Roma tomatoes', value: '18 lbs' },
  { id: 'a5', timestamp: 'Jun 14 · 4:15 PM', userId: 'u2', userName: 'Maria G.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'EOD entry', detail: 'Remaining count submitted', itemRef: 'Salmon fillet', value: '0 lbs' },
  { id: 'a6', timestamp: 'Jun 14 · 4:20 PM', userId: 'u3', userName: 'James T.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Over-prepped logged', itemRef: 'Ground beef 80/20', value: '1.5 lbs' },
  { id: 'a7', timestamp: 'Jun 14 · 4:22 PM', userId: 'u2', userName: 'Maria G.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'Waste log', detail: 'Quality issue logged', itemRef: 'Romaine lettuce', value: '0.5 cases' },
  { id: 'a8', timestamp: 'Jun 14 · 4:31 PM', userId: 'u3', userName: 'James T.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'EOD entry', detail: 'Remaining count submitted', itemRef: 'Ground beef 80/20', value: '14 lbs' },
  { id: 'a9', timestamp: 'Jun 14 · 4:33 PM', userId: 'u3', userName: 'James T.', userRole: 'user', storeId: 's1', storeName: 'Towson', action: 'EOD entry', detail: 'Remaining count submitted', itemRef: 'Romaine lettuce', value: '2 cases' },
  { id: 'a10', timestamp: 'Jun 14 · 5:02 PM', userId: 'u1', userName: 'Admin', userRole: 'admin', storeId: 's1', storeName: 'Towson', action: 'POS import', detail: 'POS CSV uploaded & reconciled', itemRef: 'pos_jun14.csv', value: '5 items' },
];
