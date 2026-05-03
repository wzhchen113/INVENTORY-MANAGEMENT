import React from 'react';
import {
  View, Text, TextInput, Modal, TouchableOpacity, FlatList, Platform,
} from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { PaletteEntry } from '../../lib/cmdSelectors';

interface Props {
  visible: boolean;
  onClose: () => void;
  onNavigate: (route: PaletteEntry['route']) => void;
  index: PaletteEntry[];
  /** Shown as a faint scope hint above the results when query is empty. */
  scopeHint?: string;
}

// Web-only ⌘K modal. Centered, panel2 bg with strong border. Fuzzy match
// scores entries by 2-stage: (1) substring match on label, (2) char-sequence
// presence preserving order (typical fuzzy). Higher score = earlier match
// + tighter character spacing. Press Enter to navigate, Escape to close.
export const CommandPalette: React.FC<Props> = ({
  visible,
  onClose,
  onNavigate,
  index,
  scopeHint,
}) => {
  const C = useCmdColors();
  const [query, setQuery] = React.useState('');
  const [highlightedIdx, setHighlightedIdx] = React.useState(0);

  const inputRef = React.useRef<TextInput | null>(null);

  React.useEffect(() => {
    if (visible) {
      setQuery('');
      setHighlightedIdx(0);
      // Focus next tick so the modal has mounted
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  const results = React.useMemo(() => fuzzyRank(query, index), [query, index]);

  // Keyboard handlers (web-only)
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        setHighlightedIdx((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        setHighlightedIdx((i) => Math.max(0, i - 1));
        e.preventDefault();
      } else if (e.key === 'Enter') {
        const sel = results[highlightedIdx];
        if (sel) {
          onNavigate(sel.route);
          onClose();
        }
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, results, highlightedIdx, onClose, onNavigate]);

  if (Platform.OS !== 'web') return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-start', alignItems: 'center', paddingTop: 120 }}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: '100%', maxWidth: 520 }}>
          <View
            style={{
              backgroundColor: C.panel,
              borderRadius: CmdRadius.lg,
              borderWidth: 1,
              borderColor: C.borderStrong,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg3 }}>⌘K</Text>
              <TextInput
                ref={inputRef as any}
                value={query}
                onChangeText={(v) => { setQuery(v); setHighlightedIdx(0); }}
                placeholder="Type to search…"
                placeholderTextColor={C.fg3}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  flex: 1,
                  fontFamily: mono(400),
                  fontSize: 13,
                  color: C.fg,
                  ...(Platform.OS === 'web' ? { outlineStyle: 'none' as any } : {}),
                }}
              />
            </View>
            {scopeHint && query.length === 0 ? (
              <Text
                style={{
                  fontFamily: mono(500),
                  fontSize: 9.5,
                  letterSpacing: 0.6,
                  color: C.fg3,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  textTransform: 'uppercase',
                }}
              >
                Scope: {scopeHint}
              </Text>
            ) : null}
            <FlatList
              data={results.slice(0, 10)}
              keyExtractor={(it) => `${it.type}:${it.id}`}
              renderItem={({ item, index: i }) => {
                const active = i === highlightedIdx;
                return (
                  <TouchableOpacity
                    onPress={() => { onNavigate(item.route); onClose(); }}
                    activeOpacity={0.85}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      backgroundColor: active ? C.accentBg : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 9.5,
                        color: C.fg3,
                        width: 56,
                        textTransform: 'uppercase',
                      }}
                    >
                      {item.type}
                    </Text>
                    <Text style={{ fontFamily: sans(500), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                      {item.label}
                    </Text>
                    <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                      {item.id.slice(0, 8)}
                    </Text>
                  </TouchableOpacity>
                );
              }}
              style={{ maxHeight: 360 }}
            />
            {results.length === 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 16 }}>
                No matches
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

// ── fuzzy matcher ────────────────────────────────────────────────────
// Two-stage scorer: substring match wins; otherwise score by sequential
// character presence with a tightness bonus. Stable sort preserves
// alphabetical order on ties.
function fuzzyRank(query: string, entries: PaletteEntry[]): PaletteEntry[] {
  if (!query.trim()) return entries.slice(0, 50);
  const q = query.toLowerCase();
  const scored: Array<{ entry: PaletteEntry; score: number }> = [];
  for (const e of entries) {
    const label = e.label.toLowerCase();
    let score = 0;
    if (label.includes(q)) {
      score = 1000 - label.indexOf(q);
    } else {
      // sequence match
      let qi = 0;
      let last = -1;
      let gap = 0;
      for (let i = 0; i < label.length && qi < q.length; i++) {
        if (label[i] === q[qi]) {
          if (last >= 0) gap += i - last - 1;
          last = i;
          qi++;
        }
      }
      if (qi === q.length) {
        score = 100 - gap;
      }
    }
    if (score > 0) scored.push({ entry: e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.map((s) => s.entry);
}
