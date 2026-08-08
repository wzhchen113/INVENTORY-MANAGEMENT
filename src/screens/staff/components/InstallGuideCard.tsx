// src/screens/staff/components/InstallGuideCard.tsx — Spec 153.
//
// The staff surface's "Add to Home Screen" tutorial. Rendered INLINE in
// Settings (between Text size and Report an issue) rather than in a sheet:
// staff Settings is already a scrolling settings page and a card is the
// surface's native idiom.
//
// Single-platform by design — staff sees only `detectInstallPlatform()`'s
// steps. The 3-tab switcher is an ADMIN affordance (a manager helping someone
// on a different phone); adding tabs here would be scope creep.
//
// Staff-local tokens/components + the staff catalog only. The shared pure model
// (`src/lib/installGuide.ts`) is consumed deliberately: it imports no store, so
// spec 063's "staff code never imports useStore" contract holds — the same
// footing as the staff subtree's existing `lib/webPush` and `lib/sessionWatch`
// imports.

import { useMemo } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {
  detectInstallPlatform,
  detectStandalone,
  installSteps,
  useInstallPrompt,
} from '../../../lib/installGuide';
import {
  StepIllustration,
  type StepIllustrationLabels,
  type StepIllustrationPalette,
} from '../../../components/illustrations/StepIllustration';
import { Button } from './Button';
import { useI18n } from '../i18n';
import { useStaffColors, useStaffElevation, useStaffTokens, type StaffTokens } from '../theme';

type Props = {
  testID?: string;
};

export function InstallGuideCard({ testID }: Props) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const platform = useMemo(() => detectInstallPlatform(), []);
  const { available, promptInstall } = useInstallPrompt();

  const { width: windowWidth } = useWindowDimensions();

  // Spec 154 — the drawn step pictures. StepIllustration is surface-neutral by
  // design (it reads no theme hook and no catalog), so the STAFF tokens and the
  // STAFF catalog are mapped into it right here. That is what lets one drawing
  // serve both surfaces without the staff subtree touching useStore.
  const artPalette = useMemo<StepIllustrationPalette>(
    () => ({
      frame: c.surfaceAlt,
      screen: c.surface,
      chrome: c.surfaceAlt,
      line: c.textTertiary,
      border: c.borderStrong,
      ink: c.text,
      ink2: c.textSecondary,
      highlight: c.primary,
      highlightBg: c.primaryPressedLight,
      highlightInk: c.textOnPrimary,
    }),
    [c],
  );
  const artLabels = useMemo<StepIllustrationLabels>(
    () => ({
      appName: t('chrome.installGuide.art.appName'),
      addToHomeScreen: t('chrome.installGuide.art.addToHomeScreen'),
      add: t('chrome.installGuide.art.add'),
      installApp: t('chrome.installGuide.art.installApp'),
      install: t('chrome.installGuide.art.install'),
    }),
    [t],
  );
  // The staff scale is the half-density one (spec 070 / the 2026-07 pass), so
  // the picture is smaller here than in the admin sheet.
  const artWidth = Math.max(120, Math.min(200, windowWidth - 64));

  const standalone = detectStandalone();
  const steps = installSteps(platform);
  const showInstallButton = platform !== 'ios' && available;

  // Hooks above the gate. Off-web (the EAS native build) this renders nothing
  // — there is no Home Screen to add a web app to (AC-8).
  if (Platform.OS !== 'web') return null;

  return (
    <View
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
      testID={testID ?? 'staff-install-guide'}
    >
      <Text style={[styles.cardTitle, { color: c.text }]}>
        {standalone ? t('chrome.installGuide.installed.title') : t('chrome.installGuide.title')}
      </Text>

      {standalone ? (
        // Q6 default (AC-7): a confirmation, NOT a disappearing row — on a
        // settings page a vanishing section is the more confusing outcome.
        <Text
          testID="staff-install-guide-installed"
          style={[styles.body, { color: c.textSecondary }]}
        >
          {t('chrome.installGuide.installed.body')}
        </Text>
      ) : (
        <>
          <Text style={[styles.body, { color: c.textSecondary }]}>
            {t('chrome.installGuide.intro')}
          </Text>

          {steps.map((step) => (
            <View
              key={step.key}
              testID={`staff-install-guide-step-${step.key}`}
              style={styles.step}
            >
              <View style={styles.stepRow}>
                <View style={[styles.marker, { backgroundColor: c.primary }]}>
                  <Text style={[styles.markerText, { color: c.textOnPrimary }]}>{step.n}</Text>
                </View>
                {/* Glyph tile — the OS's literal control mark, from the model
                    (never the catalog, which would translate it). */}
                <View
                  style={[
                    styles.glyphTile,
                    { backgroundColor: c.surfaceAlt, borderColor: c.borderStrong },
                  ]}
                >
                  <Text style={[styles.glyph, { color: c.text }]}>{step.glyph}</Text>
                </View>
                <Text style={[styles.stepText, { color: c.text }]}>
                  {t(`chrome.installGuide.steps.${step.key}`)}
                </Text>
              </View>
              {/* Spec 154 — the picture of the phone at this step. */}
              <View style={styles.artWrap}>
                <StepIllustration
                  testID={`staff-install-guide-art-${step.key}`}
                  art={step.art}
                  width={artWidth}
                  palette={artPalette}
                  labels={artLabels}
                />
              </View>
            </View>
          ))}

          {showInstallButton ? (
            <Button
              label={t('chrome.installGuide.installButton')}
              onPress={promptInstall}
              testID="staff-install-guide-install"
              accessibilityLabel={t('chrome.installGuide.installButtonAria')}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const makeStyles = (T: StaffTokens) =>
  StyleSheet.create({
    card: {
      borderWidth: 1,
      borderRadius: T.radius.lg,
      padding: T.spacing.lg,
      gap: T.spacing.md,
    },
    cardTitle: {
      fontSize: T.typography.bodyLarge,
      fontWeight: T.typography.bold,
    },
    body: {
      fontSize: T.typography.caption,
      lineHeight: T.typography.lineHeightBody,
    },
    step: {
      gap: T.spacing.md,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: T.spacing.md,
    },
    artWrap: {
      alignItems: 'center',
    },
    marker: {
      width: T.touchTarget.min,
      height: T.touchTarget.min,
      borderRadius: T.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    markerText: {
      fontSize: T.typography.caption,
      fontWeight: T.typography.bold,
    },
    glyphTile: {
      width: T.touchTarget.min + T.spacing.lg,
      height: T.touchTarget.min + T.spacing.lg,
      borderWidth: 1,
      borderRadius: T.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    glyph: {
      fontSize: T.typography.title,
    },
    stepText: {
      flex: 1,
      fontSize: T.typography.body,
      lineHeight: T.typography.lineHeightBody,
    },
  });
