// tests/babel-jest-dynamic-import.js
//
// Spec 033 — `babel-jest` wrapper that post-processes dynamic-import
// expressions so jest.mock(...) intercepts them.
//
// WHY THIS EXISTS
// ---------------
// `babel-preset-expo` deliberately PRESERVES `import('x')` expressions
// (rather than transpiling them to `Promise.resolve(require('x'))`) so
// Metro can produce code-split chunks on the web build. Under
// jest-expo's `node` test env, however, runtime dynamic imports go
// through Node's native ESM loader, which does NOT consult jest's
// module registry. That means a top-level `jest.mock('../lib/auth', ...)`
// is bypassed by `await import('../lib/auth')` inside the module under
// test.
//
// Symptom without this transform:
//   "A dynamic import callback was invoked without --experimental-vm-modules"
// or
//   "Unexpected import statement in CJS module."
//
// Fix: wrap `babel-jest` and rewrite every `import('literal')` in the
// transformed output to `Promise.resolve(require('literal'))`. This is
// the standard "convert ESM dynamic-import to CJS sync-require" shim
// used by `babel-plugin-dynamic-import-node`, applied via a small
// in-tree wrapper rather than a new dev-dependency.
//
// SCOPE
// -----
// - Applies to every file going through this transform (configured per
//   jest.config.js project). No-op for code that does NOT contain
//   `import(`.
// - Literal-source imports only (the regex requires a quoted string
//   inside the parens). Computed-source imports like
//   `import(varRef)` are left untouched — none exist in src/ today,
//   and the static-string requirement matches what jest.mock paths
//   expect anyway.
// - Preserves `babel-jest`'s caching contract by delegating
//   getCacheKey / getCacheKeyAsync to the upstream transformer.
//
// SAFETY NOTE
// -----------
// `Promise.resolve(require(...))` is NOT semantically identical to
// `import(...)` for top-level await scenarios in real ESM modules, but
// the jest `node` env is CommonJS under the hood — so this shim is the
// canonical commonjs interop shape, identical to what
// `babel-plugin-dynamic-import-node` emits.

const crypto = require('crypto');
const fs = require('fs');
const babelJest = require('babel-jest').default;
const upstream = babelJest.createTransformer();

// Match `import('literal')` or `import("literal")` or `import(\`literal\`)`.
// The literal-only requirement is deliberate (see SCOPE above).
const DYNAMIC_IMPORT_RX = /\bimport\((['"`])([^'"`]+)\1\)/g;

// Code-reviewer spec 033 S1: fold the wrapper file's own content into the
// cache key. Without this, edits to DYNAMIC_IMPORT_RX or `rewrite` would
// hit a stale upstream cache and serve unpatched output until the user
// runs `jest --clearCache`.
const THIS_FILE_HASH = crypto
  .createHash('sha1')
  .update(fs.readFileSync(__filename))
  .digest('hex')
  .slice(0, 16);

function mixCacheKey(upstreamKey) {
  return crypto
    .createHash('sha1')
    .update(upstreamKey)
    .update(THIS_FILE_HASH)
    .digest('hex')
    .slice(0, 32);
}

function rewrite(code) {
  if (!code || code.indexOf('import(') < 0) return code;
  return code.replace(DYNAMIC_IMPORT_RX, "Promise.resolve(require($1$2$1))");
}

module.exports = {
  canInstrument: upstream.canInstrument,
  getCacheKey(...args) {
    return mixCacheKey(upstream.getCacheKey(...args));
  },
  getCacheKeyAsync: upstream.getCacheKeyAsync
    ? async function (...args) {
        return mixCacheKey(await upstream.getCacheKeyAsync(...args));
      }
    : undefined,
  process(sourceText, sourcePath, options) {
    const result = upstream.process(sourceText, sourcePath, options);
    if (typeof result === 'string') return rewrite(result);
    return { ...result, code: rewrite(result.code) };
  },
  processAsync: upstream.processAsync
    ? async function (sourceText, sourcePath, options) {
        const result = await upstream.processAsync(
          sourceText,
          sourcePath,
          options,
        );
        if (typeof result === 'string') return rewrite(result);
        return { ...result, code: rewrite(result.code) };
      }
    : undefined,
};
