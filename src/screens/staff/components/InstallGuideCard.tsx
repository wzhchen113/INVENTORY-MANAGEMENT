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
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  detectInstallPlatform,
  detectStandalone,
  installSteps,
  useInstallPrompt,
} from '../../../lib/installGuide';
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
              style={styles.stepRow}
            >
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
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: T.spacing.md,
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
