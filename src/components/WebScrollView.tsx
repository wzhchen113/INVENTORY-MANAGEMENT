import React, { useEffect, useRef } from 'react';
import { View, ScrollView, Platform, ViewStyle } from 'react-native';

let styleInjected = false;

interface WebScrollViewProps {
  children: React.ReactNode;
  contentContainerStyle?: ViewStyle;
  id?: string;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
}

export function WebScrollView({ children, contentContainerStyle, id = 'web-scroll', keyboardShouldPersistTaps }: WebScrollViewProps) {
  const wrapId = id + '-wrap';
  const scrollId = id;

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

  if (Platform.OS === 'web') {
    return (
      <View nativeID={wrapId} style={{ flex: 1 }}>
        <View nativeID={scrollId}>
          <View style={contentContainerStyle}>{children}</View>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={contentContainerStyle} keyboardShouldPersistTaps={keyboardShouldPersistTaps}>
      {children}
    </ScrollView>
  );
}
