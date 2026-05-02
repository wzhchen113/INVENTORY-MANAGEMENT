import React from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';

// Tiny mono "☾ dark" / "☼ light" pill. Uses the existing Zustand
// toggleDarkMode action so the change persists to localStorage immediately
// and to the user's profile.dark_mode in the background. The legacy app's
// profile sidebar exposes the same control, but only when NEW_UI=false —
// this ensures the toggle is reachable from inside the cmd UI too.
export const ThemeToggle: React.FC = () => {
  const C = useCmdColors();
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  return (
    <TouchableOpacity
      onPress={toggleDarkMode}
      activeOpacity={0.85}
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
        {darkMode ? '☼ light' : '☾ dark'}
      </Text>
    </TouchableOpacity>
  );
};
