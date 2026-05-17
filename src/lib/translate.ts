// src/lib/translate.ts
//
// Spec 040 P3b — translation surface. Re-exports `translateOnSave` from
// db.ts so callers (form drawers, manual-fill UI) can import it from a
// translation-specific module without crossing the DB-layer barrier.
//
// Why a re-export and not the canonical home: the user's implementation
// prompt placed `translateOnSave` in db.ts (alongside `saveLocale` and the
// rest of the edge-function wrappers). The architect's design §6 preferred
// a separate `src/lib/translate.ts`. Both can coexist — this file is the
// import-path entry the architect's design implies, while db.ts owns the
// actual implementation per the user's directive.
//
// If a future spec adds non-DeepL translation providers or a glossary
// layer, the implementation can migrate from db.ts to this module and
// the public import path stays stable.

export { translateOnSave } from './db';
