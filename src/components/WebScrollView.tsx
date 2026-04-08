import React, { useEffect, useRef } from 'react';
import { View, ScrollView, Platform, ViewStyle } from 'react-native';
import { useColors } from '../theme/colors';

let styleInjected = false;

interface WebScrollViewProps {
  children: React.ReactNode;
  contentContainerStyle?: ViewStyle;
  style?: ViewStyle;
  id?: string;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}

export function WebScrollView({ children, contentContainerStyle, style, id = 'web-scroll', keyboardShouldPersistTaps }: WebScrollViewProps) {
  const wrapId = id + '-wrap';
  const scrollId = id;
  const C = useColors();

  useEffect(() => {
    if (Platform.OS === 'web' && !styleInjected) {
      const s = document.createElement('style');
      s.id = 'web-scroll-style';
      s.textContent = [
        '.web-scroll-wrap { position: relative; flex: 1; min-height: 0; }',
        '.web-scroll-inner { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow-y: auto; }',
      ].join(' ');
      document.head.appendChild(s);
      styleInjected = true;
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const wrapEl = document.getElementById(wrapId);
      const scrollEl = document.getElementById(scrollId);
      if (wrapEl) wrapEl.classList.add('web-scroll-wrap');
      if (scrollEl) scrollEl.classList.add('web-scroll-inner');
    }
  });

  // Use passed style bg, or fall back to theme bgTertiary for overscroll coverage
  const bg = (style as any)?.backgroundColor || C.bgTertiary;

  if (Platform.OS === 'web') {
    return (
      <View nativeID={wrapId} style={[{ flex: 1, backgroundColor: bg }, style]}>
        <View nativeID={scrollId} style={{ backgroundColor: bg }}>
          <View style={contentContainerStyle}>{children}</View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={[{ flex: 1, backgroundColor: bg }, style]} contentContainerStyle={contentContainerStyle} keyboardShouldPersistTaps={keyboardShouldPersistTaps}>
      {children}
    </ScrollView>
  );
}
