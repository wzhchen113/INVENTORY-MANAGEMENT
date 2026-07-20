const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Spec 132 — the Chrome MV3 extension (`extension/`) is a SEPARATE build
// artifact (its own esbuild bundle, out of the Expo Metro graph — D-6). Block
// Metro from ever resolving/watching it so `npx expo export --platform web`
// (Vercel) and EAS builds never pick it up. `blockList` accepts a RegExp; keep
// any Metro default already present.
const EXTENSION_BLOCK = new RegExp(`${path.resolve(__dirname, 'extension')}/.*`);
config.resolver.blockList = config.resolver.blockList
  ? [].concat(config.resolver.blockList, EXTENSION_BLOCK)
  : EXTENSION_BLOCK;

// Zustand's ESM build uses import.meta which Metro can't handle on web.
// Redirect zustand imports to the CJS build.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'zustand') {
    return {
      filePath: path.resolve(__dirname, 'node_modules/zustand/index.js'),
      type: 'sourceFile',
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
