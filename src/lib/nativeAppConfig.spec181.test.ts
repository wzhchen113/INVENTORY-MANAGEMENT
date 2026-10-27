// src/lib/nativeAppConfig.spec181.test.ts — Spec 181 §5.10 (durable CI pin).
//
// Reads app.json, eas.json, App.tsx and scripts/gen_logo.py as text/JSON and
// pins the native-build config decisions so a later edit (or a plugin-driven
// rewrite) can't silently undo them:
//   - AC-18: removed Android permissions stay removed AND blocked; no camera
//     usage string; iPhone-only; `imr` scheme.
//   - AC-19: slug / bundle id / package / EAS projectId / owner unchanged.
//   - AC-22: every brand-colour field equals gen_logo.py's `BG` tuple (the one
//     source of truth — JSON can't import a Python constant); splash is the
//     expo-splash-screen plugin, not the legacy top-level key.
//   - AC-20: eas.json `simulator` profile; every build profile names its EAS
//     environment.
//   - AC-16: App.tsx never prompts for notification permission and uses the
//     non-deprecated handler keys.
//   - Review fixes: android.allowBackup is false (security M2: AsyncStorage
//     holds the Supabase refresh token); no NSAllowsArbitraryLoads (AC-26);
//     App.tsx mounts installAuthAutoRefresh().
// Precedent for fs-reading source in jest: src/lib/placeholderEmail.parity.test.ts.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

type PluginEntry = string | [string, Record<string, unknown>];
type AppJson = {
  expo: {
    slug: string;
    scheme?: string;
    owner?: string;
    splash?: unknown;
    ios: { supportsTablet?: boolean; bundleIdentifier: string; infoPlist?: Record<string, unknown> };
    android: {
      package: string;
      allowBackup?: boolean;
      permissions?: string[];
      blockedPermissions?: string[];
      adaptiveIcon: { foregroundImage: string; backgroundColor: string };
    };
    plugins: PluginEntry[];
    extra: { eas: { projectId: string } };
  };
};
type EasJson = { build: Record<string, { environment?: string; ios?: { simulator?: boolean }; developmentClient?: boolean }> };

const app = (JSON.parse(read('app.json')) as AppJson).expo;
const eas = JSON.parse(read('eas.json')) as EasJson;
const appTsx = read('App.tsx');
const genLogo = read('scripts/gen_logo.py');

function bgHexFromGenLogo(): string {
  const m = genLogo.match(/^BG\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*\)/m);
  if (!m) throw new Error('BG tuple not found in scripts/gen_logo.py');
  return (
    '#' +
    [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function plugin(name: string): PluginEntry | undefined {
  return app.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
}

const REMOVED = ['CAMERA', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'];

describe('app.json — permissions + device family (AC-18)', () => {
  it('android.permissions carries none of the removed permissions (short or qualified)', () => {
    const perms = app.android.permissions ?? [];
    for (const p of REMOVED) {
      expect(perms).not.toContain(p);
      expect(perms).not.toContain(`android.permission.${p}`);
    }
    expect(perms).toEqual(expect.arrayContaining(['RECEIVE_BOOT_COMPLETED', 'VIBRATE']));
  });

  it('android.blockedPermissions blocks all three (fully qualified)', () => {
    expect(app.android.blockedPermissions).toEqual(
      expect.arrayContaining(REMOVED.map((p) => `android.permission.${p}`)),
    );
  });

  it('no NSCameraUsageDescription; ITSAppUsesNonExemptEncryption stays false', () => {
    expect(app.ios.infoPlist).not.toHaveProperty('NSCameraUsageDescription');
    expect(app.ios.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it('iPhone only, and the imr scheme is declared', () => {
    expect(app.ios.supportsTablet).toBe(false);
    expect(app.scheme).toBe('imr');
  });

  it('android.allowBackup is explicitly false (security M2)', () => {
    // Unset → Expo writes android:allowBackup="true", so Auto Backup / device
    // transfer would copy AsyncStorage (the persisted Supabase session).
    expect(app.android.allowBackup).toBe(false);
  });

  it('never sets NSAllowsArbitraryLoads (AC-26: no ATS weakening)', () => {
    expect(JSON.stringify(app)).not.toContain('NSAllowsArbitraryLoads');
  });

  it('the expo-notifications plugin is still configured', () => {
    expect(plugin('expo-notifications')).toBeDefined();
  });
});

describe('app.json — identity unchanged (AC-19)', () => {
  it('slug, bundle id, package, EAS projectId and owner are the pinned values', () => {
    expect(app.slug).toBe('towson-inventory');
    expect(app.ios.bundleIdentifier).toBe('com.towson.inventory');
    expect(app.android.package).toBe('com.towson.inventory');
    expect(app.extra.eas.projectId).toBe('8533e882-6bf6-45f8-bf57-e7b9d1c9bf57');
    expect(app.owner).toBe('wzhchen113');
  });
});

describe('app.json — brand colour + splash (AC-22)', () => {
  const BG = bgHexFromGenLogo();

  it('gen_logo.py BG is the documented #1A1A18', () => {
    expect(BG).toBe('#1A1A18');
  });

  it('adaptive-icon backgroundColor equals gen_logo.py BG', () => {
    expect(app.android.adaptiveIcon.backgroundColor.toUpperCase()).toBe(BG);
  });

  it('splash is the expo-splash-screen plugin on BG (no legacy top-level splash key)', () => {
    expect(app.splash).toBeUndefined();
    const entry = plugin('expo-splash-screen');
    expect(Array.isArray(entry)).toBe(true);
    const opts = (entry as [string, Record<string, unknown>])[1];
    expect(String(opts.backgroundColor).toUpperCase()).toBe(BG);
    expect(opts.image).toBe('./assets/splash-icon.png');
    expect(fs.existsSync(path.join(ROOT, 'assets/splash-icon.png'))).toBe(true);
  });
});

describe('eas.json — profiles (AC-20)', () => {
  it('has a standalone simulator profile (ios.simulator, not a dev client)', () => {
    const sim = eas.build.simulator;
    expect(sim).toBeDefined();
    expect(sim.ios?.simulator).toBe(true);
    expect(sim.developmentClient).toBeUndefined();
  });

  it('keeps development / preview / production', () => {
    expect(eas.build.development?.developmentClient).toBe(true);
    expect(eas.build.preview).toBeDefined();
    expect(eas.build.production).toBeDefined();
  });

  it('every build profile declares its EAS environment', () => {
    for (const [name, profile] of Object.entries(eas.build)) {
      expect({ name, environment: profile.environment }).toEqual({
        name,
        environment: expect.stringMatching(/^(development|preview|production)$/),
      });
    }
  });
});

describe('App.tsx — no boot-time notification prompt (AC-16)', () => {
  it('never requests notification permission or registers for push at boot', () => {
    expect(appTsx).not.toContain('requestPermissionsAsync');
    expect(appTsx).not.toContain('registerForPushNotifications');
  });

  it('uses the non-deprecated handler keys', () => {
    expect(appTsx).not.toContain('shouldShowAlert');
    expect(appTsx).toContain('shouldShowBanner');
    expect(appTsx).toContain('shouldShowList');
  });
});

describe('App.tsx — native auth auto-refresh is mounted', () => {
  it('imports and calls installAuthAutoRefresh()', () => {
    expect(appTsx).toMatch(/import\s*\{[^}]*\binstallAuthAutoRefresh\b[^}]*\}\s*from\s*'\.\/src\/lib\/authAutoRefresh'/);
    expect(appTsx).toContain('installAuthAutoRefresh()');
  });
});
