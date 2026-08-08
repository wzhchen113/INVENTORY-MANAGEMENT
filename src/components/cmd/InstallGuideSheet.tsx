// src/components/cmd/InstallGuideSheet.tsx — Spec 153.
//
// The admin surface's "Add to Home Screen" tutorial. A ResponsiveSheet (phone
// fullscreen / tablet + desktop right-drawer) carrying a 3-tab platform
// switcher and the numbered step cards produced by the pure `installSteps()`
// model in `src/lib/installGuide.ts`.
//
// Deliberate shape notes:
//   - The tab is SEEDED from `detectInstallPlatform()` but freely switchable:
//     a manager helping a staff member on a different phone needs the other
//     tab (AC-4). The step list is computed in render from `activeId`, and the
//     body is NOT keyed on the tab, so switching re-renders without remounting.
//   - NO real screenshots: each step is a numbered marker + a mono glyph tile
//     carrying the OS's literal control mark + localized text (AC-6). The
//     glyphs come from the model, never the catalog.
//   - The one-tap install button needs BOTH gates (AC-9): a captured
//     `beforeinstallprompt` AND a non-iOS tab (iOS Safari has no such event).
//   - `detectStandalone()` true → the "already added" body instead of the
//     tabs. The shell hides the entry in that state, but the sheet is still
//     reachable by a direct `visible` prop and must not be a dead end.

import React from 'react';
import { Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, Type } from '../../theme/typography';
import { useT } from '../../hooks/useT';
import {
  detectInstallPlatform,
  detectStandalone,
  installSteps,
  useInstallPrompt,
  type InstallPlatform,
} from '../../lib/installGuide';
import { ResponsiveSheet } from './ResponsiveSheet';
import { TabStrip } from './TabStrip';

interface InstallGuideSheetProps {
  visible: boolean;
  onClose: () => void;
}

export const InstallGuideSheet: React.FC<InstallGuideSheetProps> = ({ visible, onClose }) => {
  const C = useCmdColors();
  const T = useT();
  // Seeded once from the live probe; the user owns it from then on (AC-4).
  const [activeId, setActiveId] = React.useState<InstallPlatform>(() => detectInstallPlatform());
  const { available, promptInstall } = useInstallPrompt();

  const tabs = React.useMemo(
    () => [
      { id: 'ios', label: T('chrome.installGuide.tabs.ios'), testID: 'install-guide-tab-ios' },
      { id: 'android', label: T('chrome.installGuide.tabs.android'), testID: 'install-guide-tab-android' },
      { id: 'desktop', label: T('chrome.installGuide.tabs.desktop'), testID: 'install-guide-tab-desktop' },
    ],
    [T],
  );

  const standalone = detectStandalone();
  const steps = installSteps(activeId);
  const showInstallButton = activeId !== 'ios' && available;

  // Hooks above the gate (the project's guard-after-hooks convention). Off-web
  // this renders nothing at all — AC-8.
  if (Platform.OS !== 'web') return null;

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
      }}
    >
      <Text style={[Type.caption, { color: C.fg }]}>{T('chrome.installGuide.title')}</Text>
      <TouchableOpacity
        testID="install-guide-close"
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={T('common.closeAria')}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>✕</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      presentation={{ phone: 'fullscreen', tablet: 'right-drawer', desktop: 'right-drawer' }}
      desktopWidth={480}
      accessibilityLabel={T('chrome.installGuide.title')}
      header={header}
    >
      {/* ResponsiveSheet takes no testID prop (shared component — not extended
          here); the AC-2 handle lives on this inner root instead. */}
      <View testID="install-guide-sheet" style={{ flex: 1, minHeight: 0 }}>
        {standalone ? (
          <View testID="install-guide-installed" style={{ padding: 24, gap: 8 }}>
            <Text style={[Type.h2, { color: C.fg }]}>{T('chrome.installGuide.installed.title')}</Text>
            <Text style={[Type.body, { color: C.fg2 }]}>{T('chrome.installGuide.installed.body')}</Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={tabs}
              activeId={activeId}
              onChange={(id) => setActiveId(id as InstallPlatform)}
              fillEvenly
            />
            <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 28 }}>
              <Text style={[Type.body, { color: C.fg2 }]}>{T('chrome.installGuide.intro')}</Text>

              {steps.map((step) => (
                <View
                  key={step.key}
                  testID={`install-guide-step-${step.key}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: C.border,
                    borderRadius: CmdRadius.md,
                    backgroundColor: C.panel,
                  }}
                >
                  {/* Numbered marker */}
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: CmdRadius.pill,
                      backgroundColor: C.accent,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.accentFg }}>
                      {step.n}
                    </Text>
                  </View>
                  {/* Glyph tile — the OS's real control mark, not translated */}
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: C.borderStrong,
                      backgroundColor: C.panel2,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Text style={{ fontFamily: mono(500), fontSize: 18, color: C.fg }}>
                      {step.glyph}
                    </Text>
                  </View>
                  <Text style={[Type.body, { color: C.fg, flex: 1 }]}>
                    {T(`chrome.installGuide.steps.${step.key}`)}
                  </Text>
                </View>
              ))}

              {showInstallButton ? (
                <TouchableOpacity
                  testID="install-guide-install-button"
                  onPress={promptInstall}
                  accessibilityRole="button"
                  accessibilityLabel={T('chrome.installGuide.installButtonAria')}
                  activeOpacity={0.85}
                  style={{
                    minHeight: 44,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: CmdRadius.sm,
                    backgroundColor: C.accent,
                  }}
                >
                  <Text style={{ fontFamily: mono(600), fontSize: 12, color: C.accentFg }}>
                    {T('chrome.installGuide.installButton')}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </>
        )}
      </View>
    </ResponsiveSheet>
  );
};
