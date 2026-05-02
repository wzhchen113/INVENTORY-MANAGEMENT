// Build-time feature flags. EXPO_PUBLIC_* vars are inlined by Expo at bundle
// time. Default off; flip via .env.local (gitignored) or per-environment
// config. Phase-9 cleanup will remove this once the new UI is the default.

export const NEW_UI = process.env.EXPO_PUBLIC_NEW_UI === 'true';
