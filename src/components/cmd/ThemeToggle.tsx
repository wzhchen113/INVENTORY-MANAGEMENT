import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';

interface Props {
  /** Presentation variant (spec 142).
   *  - `full` (default): the byte-identical rail/title-bar text pill.
   *  - `bar`: phone top-app-bar mode — a ≥44×44 icon-only ◐ glyph (no text),
   *    so the trailing cluster stays narrow and clears the 44×44 hit floor
   *    (AC-C1). Used ONLY from ResponsiveCmdShell's phone branch. */
  variant?: 'full' | 'bar';
}

// Tiny mono "☾ dark" / "☼ light" pill. Uses the existing Zustand
// toggleDarkMode action so the change persists to localStorage immediately
// and to the user's profile.dark_mode in the background. Spec 038 routes
// the label and accessibilityLabel through useT() so Spanish / Chinese
// users see translated chrome.
export const ThemeToggle: React.FC<Props> = ({ variant = 'full' }) => {
  const C = useCmdColors();
  const T = useT();
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);

  if (variant === 'bar') {
    return (
      <TouchableOpacity
        onPress={toggleDarkMode}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.themeToggle.aria')}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>◐</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={toggleDarkMode}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={T('chrome.themeToggle.aria')}
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: CmdRadius.xs,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.panel2,
      }}
    >
      <Text style={{ fontFamily: mono(500), fontSize: 9.5, color: C.fg2 }}>
        {darkMode ? T('chrome.themeToggle.lightLabel') : T('chrome.themeToggle.darkLabel')}
      </Text>
    </TouchableOpacity>
  );
};
