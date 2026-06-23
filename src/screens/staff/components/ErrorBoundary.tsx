// src/components/ErrorBoundary.tsx — whole-stack error fallback.
//
// Spec 062 §0 Q3 — log-only-no-UI behavior. Wraps the entire navigator
// at App.tsx so a render error doesn't drop the user into a blank
// screen. Persistent storage (the offline queue) is the source of
// truth for queued counts; an in-memory crash doesn't lose them.
//
// Spec 070: a class component can't call hooks, so the themed fallback
// UI is extracted into the `ErrorFallback` function component (which
// calls `useStaffColors()`); the class `render()` returns it on error.
// The boundary's getDerivedStateFromError / componentDidCatch logic is
// untouched.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { spacing, typography, useStaffColors } from '../theme';
import { t } from '../i18n';

type Props = { children: ReactNode };

type State = { hasError: boolean };

function ErrorFallback() {
  const c = useStaffColors();
  // Spec 099: this fallback intentionally uses the bare (snapshot) `t`
  // rather than the reactive `useI18n()` hook. It only renders after a
  // render crash inside the boundary, and live-switching the locale on the
  // crash screen is out of scope — the strings still reflect the locale
  // active at crash time. Not worth wiring reactivity into the one place
  // the app has already failed.
  return (
    <View
      style={[styles.fallback, { backgroundColor: c.bg }]}
      accessibilityRole="alert"
    >
      <Text style={[styles.title, { color: c.text }]}>
        {t('chrome.errorBoundary.title')}
      </Text>
      <Text style={[styles.message, { color: c.textSecondary }]}>
        {t('chrome.errorBoundary.message')}
      </Text>
    </View>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log-only fallback per spec — no toast, no remote crash-report
    // surface in v1. The console.warn surfaces in Metro logs and
    // browser devtools.
    // eslint-disable-next-line no-console
    console.warn('[ErrorBoundary] caught render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  message: {
    fontSize: typography.body,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: typography.lineHeightBody,
  },
});
