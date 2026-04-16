// src/lib/orderCalculator.ts
import { InventoryItem, Vendor } from '../types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DynamicOrderLine {
  itemId: string;
  itemName: string;
  category: string;
  unit: string;
  vendor: string;
  dailyUsage: number;
  safetyStock: number;
  daysToCover: number;
  dynamicPar: number;
  eodRemaining: number;
  orderQuantity: number;
  costPerUnit: number;
  estimatedCost: number;
}

/**
 * Given an order date and a vendor's delivery schedule, calculate
 * how many days the order must cover (until the NEXT delivery after this one).
 */
export function getDaysToCover(orderDate: Date, vendor: Vendor): number {
  const orderDayIndex = orderDate.getDay(); // 0=Sun ... 6=Sat
  const deliveryIndices = vendor.deliveryDays
    .map((d) => DAY_NAMES.indexOf(d))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);

  if (deliveryIndices.length === 0) return 7; // fallback: 1 week

  // Find the NEXT delivery day AFTER this order's delivery
  // The order placed today arrives after leadTimeDays, on the delivery day itself.
  // We need enough stock to last until the NEXT delivery after that.
  // Find the next delivery day index that comes after orderDayIndex
  let nextDeliveryAfter = deliveryIndices.find((d) => d > orderDayIndex);
  if (nextDeliveryAfter === undefined) {
    nextDeliveryAfter = deliveryIndices[0]; // wrap to next week
  }

  let gap = nextDeliveryAfter - orderDayIndex;
  if (gap <= 0) gap += 7;

  return gap;
}

/**
 * Calculate dynamic order list for a specific vendor on a specific date.
 * dynamicPar = (averageDailyUsage × daysToCover) + safetyStock
 * orderQuantity = max(0, ceil(dynamicPar − eodRemaining))
 */
export function calculateDynamicOrder(
  inventory: InventoryItem[],
  vendor: Vendor,
  orderDate: Date,
): DynamicOrderLine[] {
  const daysToCover = getDaysToCover(orderDate, vendor);

  return inventory
    .filter((item) => item.vendorId === vendor.id || item.vendorName?.toLowerCase() === vendor.name?.toLowerCase())
    .map((item) => {
      // Use parLevel as target if averageDailyUsage not set
      const dynamicPar = item.averageDailyUsage > 0
        ? (item.averageDailyUsage * daysToCover) + item.safetyStock
        : item.parLevel; // fallback: par level is the restock target
      const orderQuantity = Math.max(0, Math.ceil(dynamicPar - item.eodRemaining));
      return {
        itemId: item.id,
        itemName: item.name,
        category: item.category,
        unit: item.unit,
        vendor: vendor.name,
        dailyUsage: item.averageDailyUsage,
        safetyStock: item.safetyStock,
        daysToCover,
        dynamicPar: Math.ceil(dynamicPar),
        eodRemaining: item.eodRemaining,
        orderQuantity,
        costPerUnit: item.costPerUnit,
        estimatedCost: orderQuantity * item.costPerUnit,
      };
    })
    .filter((line) => line.orderQuantity > 0)
    .sort((a, b) => a.category.localeCompare(b.category) || a.itemName.localeCompare(b.itemName));
}
