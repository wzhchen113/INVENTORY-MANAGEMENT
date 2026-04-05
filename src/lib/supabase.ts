// src/lib/supabase.ts
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Replace these with your actual Supabase project values ───────────────
// Go to: https://supabase.com → Your Project → Settings → API
const SUPABASE_URL = 'https://ebwnovzzkwhsdxkpyjka.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_0FISU7Bq0-z601E-kWWykA_rtOw8GIA';
// ──────────────────────────────────────────────────────────────────────────

// On web, use undefined so Supabase JS falls back to localStorage.
// On native, use AsyncStorage for session persistence.
const storage = Platform.OS === 'web' ? undefined : AsyncStorage;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});
