// src/data/seed.ts
// Empty seed data — all real data comes from Supabase
import {
  User, Store, InventoryItem, Recipe, Vendor,
  WasteEntry, AuditEvent, PrepRecipe,
  EODSubmission, POSImport,
} from '../types';

export const STORES: Store[] = [];
export const USERS: User[] = [];
export const INVENTORY: InventoryItem[] = [];
export const RECIPES: Recipe[] = [];
export const VENDORS: Vendor[] = [];
export const WASTE_LOG: WasteEntry[] = [];
export const AUDIT_LOG: AuditEvent[] = [];
export const PREP_RECIPES: PrepRecipe[] = [];
export const EOD_SUBMISSIONS: EODSubmission[] = [];
export const POS_IMPORTS: POSImport[] = [];
