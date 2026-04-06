import pandas as pd
import sys

df = pd.read_excel(r'C:\Users\wzhch\Downloads\Item_Ingredient_Mapping.xlsx', sheet_name='Item Ingredient Mapping')
df['Item Name'] = df['Item Name'].ffill()
df['Category'] = df['Category'].ffill()

recipes_data = {}
for _, row in df.iterrows():
    item = row['Item Name']
    cat = row['Category']
    ing = row['Ingredient']
    if item not in recipes_data:
        recipes_data[item] = {'category': cat, 'ingredients': []}
    recipes_data[item]['ingredients'].append(ing)

# Find creme brulee variant in data
creme_key = None
for ing in sorted(set(df['Ingredient'].dropna())):
    if 'Brulee' in ing:
        creme_key = ing
        break

ing_defs = {
    'Beef Patty':('Protein','each',2.50,200,100),
    'Chicken Nuggets':('Protein','each',0.25,300,150),
    'Chicken Tenders':('Protein','each',1.20,150,80),
    'Chicken Wings':('Protein','lbs',3.80,80,40),
    'Chicken Wings (6pc)':('Protein','each',4.50,60,30),
    'Chicken Wings (10pc)':('Protein','each',7.00,40,20),
    'Chicken Wings (20pc)':('Protein','each',13.00,20,10),
    'Fried Chicken Breast':('Protein','each',2.80,80,40),
    'Grilled Chicken':('Protein','lbs',5.50,60,30),
    'Grilled Steak':('Protein','lbs',12.00,30,15),
    'Gyro Meat (Lamb/Beef)':('Protein','lbs',8.50,40,20),
    'Sausage':('Protein','each',1.50,50,25),
    'Shaved Chicken':('Protein','lbs',5.00,40,20),
    'Shaved Steak':('Protein','lbs',9.00,40,20),
    'Spicy Fried Chicken Breast':('Protein','each',3.00,60,30),
    'Crabmeat':('Seafood','lbs',18.00,15,8),
    'Fried Shrimp':('Seafood','lbs',10.00,30,15),
    'Grilled Shrimp':('Seafood','lbs',11.00,25,12),
    'Shrimp (Head Off)':('Seafood','lbs',9.50,20,10),
    'Snow Crab Legs':('Seafood','lbs',22.00,15,8),
    'Whiting Fish Fillet':('Seafood','each',2.00,60,30),
    'Coleslaw':('Produce','lbs',2.50,20,10),
    'Corn':('Produce','each',0.50,50,25),
    'Cucumber':('Produce','each',0.75,30,15),
    'Green Peppers':('Produce','each',0.80,40,20),
    'Lettuce':('Produce','each',1.50,40,20),
    'Mixed Greens':('Produce','lbs',4.00,20,10),
    'Mushrooms':('Produce','lbs',3.50,15,8),
    'Onion':('Produce','each',0.50,60,30),
    'Onions':('Produce','each',0.50,60,30),
    'Pickles':('Produce','each',0.15,200,100),
    'Potato':('Produce','each',0.60,50,25),
    'Tomato':('Produce','each',0.50,60,30),
    'American Cheese':('Dairy','each',0.15,300,150),
    'Butter':('Dairy','lbs',4.50,15,8),
    'Cheddar Cheese':('Dairy','lbs',5.80,15,8),
    'Milk':('Dairy','gal',4.00,8,4),
    'Provolone Cheese':('Dairy','each',0.20,200,100),
    'Shredded Cheese':('Dairy','lbs',5.00,20,10),
    'Croutons':('Dry goods','bags',3.50,10,5),
    'Elbow Pasta':('Dry goods','lbs',1.20,25,12),
    'Flour Tortilla':('Dry goods','each',0.25,100,50),
    'French Fries':('Dry goods','lbs',1.80,100,50),
    'Frying Oil':('Dry goods','gal',12.00,15,8),
    'Mozzarella Sticks':('Dry goods','each',0.40,150,80),
    'Onion Rings':('Dry goods','each',0.30,100,50),
    'Sweet Potato Fries':('Dry goods','lbs',3.00,40,20),
    'Yellow Rice':('Dry goods','lbs',1.20,50,25),
    'Burger Bun':('Bakery','each',0.40,120,60),
    'Hoagie Roll':('Bakery','each',0.60,80,40),
    'Pita Bread':('Bakery','each',0.35,100,50),
    '2AM Sauce':('Condiments','oz',0.20,256,128),
    'BBQ Sauce':('Condiments','oz',0.10,128,64),
    'Boil Seasoning':('Condiments','oz',0.30,64,32),
    'Cajun Seasoning':('Condiments','oz',0.25,64,32),
    'Cocktail Sauce':('Condiments','oz',0.15,64,32),
    'Dipping Sauce':('Condiments','oz',0.12,128,64),
    'Garlic Butter':('Condiments','oz',0.25,64,32),
    'Honey Mustard':('Condiments','oz',0.12,64,32),
    'Hot Sauce':('Condiments','oz',0.08,128,64),
    'Ketchup':('Condiments','oz',0.06,256,128),
    'Mayo':('Condiments','oz',0.08,256,128),
    'Ranch Dressing':('Condiments','oz',0.12,128,64),
    'Salad Dressing':('Condiments','oz',0.12,128,64),
    'Tartar Sauce':('Condiments','oz',0.15,64,32),
    'White Sauce':('Condiments','oz',0.10,256,128),
    'Wing Sauce':('Condiments','oz',0.12,128,64),
    'Bottled Water':('Drinks','each',0.50,100,50),
    'Can Soda':('Drinks','each',0.60,150,75),
    'Iced Tea':('Drinks','each',0.40,80,40),
    'Lemonade':('Drinks','each',0.45,80,40),
    'Cheesecake Slice':('Desserts','each',3.50,20,10),
    'Chocolate Cake Slice':('Desserts','each',3.00,20,10),
    'Tres Leches Cake':('Desserts','each',4.00,15,8),
    'Creme Brulee':('Desserts','each',4.50,15,8),
}

cat_order = ['Protein','Seafood','Produce','Dairy','Dry goods','Bakery','Condiments','Drinks','Desserts']
sorted_ings = []
for cat in cat_order:
    for name in sorted(ing_defs.keys()):
        if ing_defs[name][0] == cat:
            sorted_ings.append((name, *ing_defs[name]))

name_to_id = {}
for idx, (name, *_) in enumerate(sorted_ings, 1):
    name_to_id[name] = f'i{idx}'
if creme_key:
    name_to_id[creme_key] = name_to_id.get('Creme Brulee', '')

o = []
o.append("// src/data/seed.ts")
o.append("import {")
o.append("  User, Store, InventoryItem, Recipe, Vendor,")
o.append("  WasteEntry, PurchaseOrder, AuditEvent, PrepRecipe,")
o.append("} from '../types';")
o.append("")
o.append("export const STORES: Store[] = [")
o.append("  { id: 's1', name: 'Towson', address: '1234 York Rd, Towson MD 21204', status: 'active' },")
o.append("  { id: 's2', name: 'Baltimore', address: '456 Inner Harbor Blvd, Baltimore MD 21201', status: 'active' },")
o.append("];")
o.append("")
o.append("export const USERS: User[] = [")
o.append("  { id: 'u1', name: 'Admin (Owner)', email: 'admin@towson.com', role: 'admin', stores: ['s1','s2'], status: 'active', initials: 'AD', color: '#378ADD' },")
o.append("  { id: 'u2', name: 'Maria Garcia', email: 'maria@towson.com', role: 'user', stores: ['s1'], status: 'active', initials: 'MG', color: '#1D9E75' },")
o.append("  { id: 'u3', name: 'James Thompson', email: 'james@towson.com', role: 'user', stores: ['s1'], status: 'active', initials: 'JT', color: '#D85A30' },")
o.append("  { id: 'u4', name: 'Ana Rivera', email: 'ana@baltimore.com', role: 'user', stores: ['s2'], status: 'active', initials: 'AR', color: '#D4537E' },")
o.append("];")
o.append("")
o.append("export const INVENTORY: InventoryItem[] = [")

prev_cat = None
for name, cat, unit, cost, stock, par in sorted_ings:
    iid = name_to_id[name]
    if cat != prev_cat:
        o.append(f"  // {cat}")
        prev_cat = cat
    sn = name.replace("'", "\\'")
    o.append(f"  {{ id: '{iid}', name: '{sn}', category: '{cat}', unit: '{unit}', costPerUnit: {cost}, currentStock: {stock}, parLevel: {par}, vendorId: 'v1', vendorName: 'Sysco', usagePerPortion: 1, expiryDate: '', lastUpdatedBy: 'Admin', lastUpdatedAt: 'Today 9:00 AM', eodRemaining: {stock}, storeId: 's1' }},")

o.append("];")
o.append("")
o.append("export const PREP_RECIPES: PrepRecipe[] = [];")
o.append("")
o.append("export const RECIPES: Recipe[] = [")

for ridx, (menu_item, rdata) in enumerate(recipes_data.items(), 1):
    sm = menu_item.replace("'", "\\'")
    cat = rdata['category']
    ings = rdata['ingredients']
    ing_strs = []
    for ig in ings:
        iid = name_to_id.get(ig)
        if not iid:
            continue
        si = ig.replace("'", "\\'")
        u = ing_defs.get(ig, ('','each',0,0,0))[1]
        ing_strs.append(f"      {{ itemId: '{iid}', itemName: '{si}', quantity: 1, unit: '{u}' }},")

    o.append("  {")
    o.append(f"    id: 'r{ridx}', menuItem: '{sm}', category: '{cat}', sellPrice: 0, storeId: 's1',")
    o.append("    ingredients: [")
    for s in ing_strs:
        o.append(s)
    o.append("    ],")
    o.append("    prepItems: [],")
    o.append("  },")

o.append("];")
o.append("")
o.append("export const VENDORS: Vendor[] = [")
o.append("  { id: 'v1', name: 'Sysco', contactName: 'Mike Torres', phone: '(410) 555-0122', email: 'mike.torres@sysco.com', accountNumber: 'SYS-4421', leadTimeDays: 2, categories: ['Protein', 'Dairy', 'Dry goods', 'Condiments'], lastOrderDate: '' },")
o.append("  { id: 'v2', name: 'US Foods', contactName: 'Sarah Lee', phone: '(410) 555-0198', email: 'sarah.lee@usfoods.com', accountNumber: 'USF-8810', leadTimeDays: 3, categories: ['Seafood', 'Protein'], lastOrderDate: '' },")
o.append("  { id: 'v3', name: 'Local Farms Co.', contactName: 'Tom Greer', phone: '(443) 555-0344', email: 'tom@localfarms.com', accountNumber: 'LFC-201', leadTimeDays: 1, categories: ['Produce', 'Bakery'], lastOrderDate: '' },")
o.append("];")
o.append("")
o.append("export const WASTE_LOG: WasteEntry[] = [];")
o.append("")
o.append("export const PURCHASE_ORDERS: PurchaseOrder[] = [];")
o.append("")
o.append("export const AUDIT_LOG: AuditEvent[] = [];")

with open(r'C:\Users\wzhch\OneDrive\Documents\INVENTORY_MANAGEMENT\src\data\seed.ts', 'w') as f:
    f.write('\n'.join(o) + '\n')

print(f"Generated {len(sorted_ings)} ingredients, {len(recipes_data)} recipes")
