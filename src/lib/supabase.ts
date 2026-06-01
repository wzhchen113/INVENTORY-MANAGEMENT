// src/lib/supabase.ts
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

// On web, use undefined so Supabase JS falls back to localStorage.
// On native, use AsyncStorage for session persistence.
const storage = Platform.OS === 'web' ? undefined : AsyncStorage;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
    // Spec 085 — flowType retained at 'pkce' for defense-in-depth, but the
    // CHOSEN recovery flow is token_hash (verifyOtp), NOT PKCE. The empirical
    // cross-device test proved PKCE's exchangeCodeForSession FAILS when the
    // landing browser holds no code-verifier (the realistic admin-initiated
    // case — verifier is in the admin's browser, link is clicked in the
    // target's). token_hash is stateless and works cross-device; see spec 085
    // "Flow decision + manual steps".
    //
    // Why keep 'pkce' at all: the architect's blast-radius analysis (spec §1)
    // confirmed flowType is functionally INERT for every existing auth path —
    // sign-in (password grant), invited-registration (signUp, no redirect leg),
    // session-restore (getSession), dev session-inject (setSession) — because
    // none exercise the `?code=` exchange leg. Verified locally that admin
    // login + session-restore still work post-change. Keeping 'pkce' also means
    // a defensive `?code=` link (if a prod template ever emits the default
    // {{ .ConfirmationURL }}) is at least same-device exchangeable via the
    // recovery-code fallback in establishRecoverySession.
    flowType: 'pkce',
  },
});

// Dev-only: expose the client on window so verification scripts can inspect
// realtime channel state, run REST calls, etc. Stripped in production by
// Metro's __DEV__ DCE.
if (__DEV__ && Platform.OS === 'web') {
  (globalThis as any).__supabase = supabase;
}
