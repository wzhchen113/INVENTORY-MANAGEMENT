// src/components/ErrorBoundary.tsx — whole-stack error fallback.
//
// Spec 062 §0 Q3 — log-only-no-UI behavior. Wraps the entire navigator
// at App.tsx so a render error doesn't drop the user into a blank
// screen. Persistent storage (the offline queue) is the source of
// truth for queued counts; an in-memory crash doesn't lose them.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../theme';
import { t } from '../i18n';

type Props = { children: ReactNode };

type State = { hasError: boolean };

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
      return (
        <View style={styles.fallback} accessibilityRole="alert">
          <Text style={styles.title}>{t('chrome.errorBoundary.title')}</Text>
          <Text style={styles.message}>{t('chrome.errorBoundary.message')}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
    color: colors.text,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  message: {
    fontSize: typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 22,
  },
});
