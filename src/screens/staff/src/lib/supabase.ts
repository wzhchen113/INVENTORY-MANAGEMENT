// src/lib/supabase.ts — supabase-js client singleton for imr-staff.
//
// Trimmed mirror of imr-inventory's src/lib/supabase.ts. Per-user JWT
// only — NO shared service token. Auth persists per platform:
//   web    → undefined (supabase-js falls back to localStorage)
//   native → AsyncStorage
//
// Env vars (set via EXPO_PUBLIC_* so they ship in the bundle; the anon
// key is publishable and safe to commit):
//   EXPO_PUBLIC_SUPABASE_URL
//   EXPO_PUBLIC_SUPABASE_ANON_KEY
//
// Local-stack defaults match the imr-inventory smoke (manager@local.test).

import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

const storage = Platform.OS === 'web' ? undefined : AsyncStorage;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

// Dev-only: expose the client on globalThis so verification scripts can
// inspect session state. Metro's __DEV__ DCE strips this in production.
if (__DEV__ && Platform.OS === 'web') {
  (globalThis as { __supabase?: unknown }).__supabase = supabase;
}
