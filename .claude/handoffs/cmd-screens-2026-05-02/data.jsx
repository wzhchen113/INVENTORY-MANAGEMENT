// Shared mock data for all three layouts
const STORES = [
  { id: 'tow', name: 'Towson', address: '418 York Rd', items: 142 },
  { id: 'bal', name: 'Baltimore', address: '1100 Aliceanna St', items: 118 },
];

const CATEGORIES = ['Protein', 'Produce', 'Dairy', 'Dry Goods', 'Seafood', 'Bakery', 'Spices'];

const INVENTORY = [
  { id: 'i01', name: 'Beef tenderloin',     cat: 'Protein',   stock: 12.4, par: 18, unit: 'lb',   cost: 22.40, vendor: 'Sysco',          updated: '2h',  status: 'low'  },
  { id: 'i02', name: 'Chicken thigh',       cat: 'Protein',   stock: 38.0, par: 30, unit: 'lb',   cost:  4.80, vendor: 'US Foods',       updated: '4h',  status: 'ok'   },
  { id: 'i03', name: 'Atlantic salmon',     cat: 'Seafood',   stock:  4.2, par: 12, unit: 'lb',   cost: 14.20, vendor: 'Samuels',        updated: '1h',  status: 'low'  },
  { id: 'i04', name: 'Heirloom tomato',     cat: 'Produce',   stock: 18.6, par: 20, unit: 'lb',   cost:  3.10, vendor: 'Lancaster',      updated: '6h',  status: 'ok'   },
  { id: 'i05', name: 'Romaine hearts',      cat: 'Produce',   stock:  0.0, par: 24, unit: 'ea',   cost:  1.80, vendor: 'Lancaster',      updated: '1d',  status: 'out'  },
  { id: 'i06', name: 'Heavy cream',         cat: 'Dairy',     stock:  6.0, par:  8, unit: 'qt',   cost:  4.40, vendor: 'Trickling Springs',updated:'3h', status: 'ok'   },
  { id: 'i07', name: 'Unsalted butter',     cat: 'Dairy',     stock: 14.0, par: 10, unit: 'lb',   cost:  3.90, vendor: 'Trickling Springs',updated:'5h', status: 'ok'   },
  { id: 'i08', name: 'AP flour',            cat: 'Dry Goods', stock: 50.0, par: 50, unit: 'lb',   cost:  0.62, vendor: 'Restaurant Depot',updated: '2d', status: 'ok'   },
  { id: 'i09', name: 'Olive oil EV',        cat: 'Dry Goods', stock:  2.1, par:  6, unit: 'gal',  cost: 38.00, vendor: 'Sysco',          updated: '8h',  status: 'low'  },
  { id: 'i10', name: 'Brioche buns',        cat: 'Bakery',    stock: 36.0, par: 48, unit: 'ea',   cost:  0.55, vendor: 'H&S Bakery',     updated: '2h',  status: 'low'  },
  { id: 'i11', name: 'Smoked paprika',      cat: 'Spices',    stock:  1.4, par:  2, unit: 'lb',   cost: 18.00, vendor: 'The Spice Lab',  updated: '5d',  status: 'ok'   },
  { id: 'i12', name: 'Maine lobster',       cat: 'Seafood',   stock:  0.0, par:  8, unit: 'lb',   cost: 28.00, vendor: 'Samuels',        updated: '1d',  status: 'out'  },
];

const KPIS = {
  inventoryValue: 18420,
  foodCostPct: 31.4,
  wasteWeek: 412,
  openPOs: 7,
  lowStock: 4,
  outStock: 2,
  ordersDue: 3,
  eodSubmitted: 18,
  eodTotal: 24,
};

// last 14 days food cost %
const FOOD_COST_TREND = [29.8, 30.2, 31.4, 32.1, 30.6, 30.9, 31.8, 32.4, 31.2, 30.4, 31.0, 31.6, 32.0, 31.4];

// usage by category (% of total)
const CATEGORY_MIX = [
  { name: 'Protein',   pct: 42, value: 7740 },
  { name: 'Produce',   pct: 18, value: 3320 },
  { name: 'Dairy',     pct: 12, value: 2210 },
  { name: 'Dry Goods', pct: 11, value: 2030 },
  { name: 'Seafood',   pct: 10, value: 1840 },
  { name: 'Bakery',    pct:  4, value:  740 },
  { name: 'Spices',    pct:  3, value:  540 },
];

const RECENT_ACTIVITY = [
  { who: 'MG', name: 'Maria Garcia',   action: 'submitted EOD count', target: '24 items',           ago: '12m', tone: 'info'    },
  { who: 'JT', name: 'James Thompson', action: 'logged waste',         target: '1.2 lb salmon',     ago: '38m', tone: 'warning' },
  { who: 'AD', name: 'Admin',          action: 'received PO',          target: 'Sysco #4821',       ago: '1h',  tone: 'success' },
  { who: 'AR', name: 'Ana Rivera',     action: 'imported POS',         target: 'toast_2026-04-30',  ago: '2h',  tone: 'info'    },
  { who: 'AD', name: 'Admin',          action: 'updated par level',    target: 'Heirloom tomato',   ago: '3h',  tone: 'neutral' },
  { who: 'JT', name: 'James Thompson', action: 'logged waste',         target: '0.8 qt cream',      ago: '5h',  tone: 'warning' },
];

const PURCHASE_ORDERS = [
  { id: 'PO-4821', vendor: 'Sysco',          status: 'received', total:  842.40, date: 'Apr 30', items: 12 },
  { id: 'PO-4820', vendor: 'Lancaster',      status: 'sent',     total:  318.20, date: 'Apr 30', items:  8 },
  { id: 'PO-4819', vendor: 'Samuels',        status: 'sent',     total:  612.00, date: 'Apr 29', items:  4 },
  { id: 'PO-4818', vendor: 'H&S Bakery',     status: 'draft',    total:   96.00, date: 'Apr 29', items:  3 },
  { id: 'PO-4817', vendor: 'US Foods',       status: 'received', total: 1240.80, date: 'Apr 28', items: 18 },
];

const VENDORS = [
  { name: 'Sysco',           lead: 1, cutoff: '15:00', days: 'Mon Wed Fri', categories: 'Protein, Dry Goods'  },
  { name: 'US Foods',        lead: 1, cutoff: '14:00', days: 'Tue Thu',     categories: 'Protein'              },
  { name: 'Lancaster',       lead: 1, cutoff: '12:00', days: 'Tue Fri',     categories: 'Produce'              },
  { name: 'Samuels',         lead: 2, cutoff: '11:00', days: 'Mon Thu',     categories: 'Seafood'              },
  { name: 'Trickling Springs',lead:1, cutoff: '13:00', days: 'Wed Sat',     categories: 'Dairy'                },
  { name: 'H&S Bakery',      lead: 1, cutoff: '16:00', days: 'Daily',       categories: 'Bakery'               },
];

window.IM_DATA = { STORES, CATEGORIES, INVENTORY, KPIS, FOOD_COST_TREND, CATEGORY_MIX, RECENT_ACTIVITY, PURCHASE_ORDERS, VENDORS };
