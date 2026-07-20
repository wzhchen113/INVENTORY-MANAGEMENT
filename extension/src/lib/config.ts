// Spec 132 (D-2) — compile-time config. The Supabase project URL + the PUBLIC
// anon key are injected by esbuild `define` at build time from the env
// (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY — the SAME public
// values already shipped in the web bundle; the anon key is NOT a secret, RLS is
// the only thing that bounds access). NO service-role key. NO vendor credential.

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const SUPABASE_URL: string = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
export const SUPABASE_ANON_KEY: string =
  typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : '';
