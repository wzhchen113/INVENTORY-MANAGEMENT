// src/components/cmd/GuideSheet.tsx — Spec 158 §3.
//
// The shell-owned `?` sheet: a ResponsiveSheet (phone fullscreen / tablet +
// desktop right-drawer) showing the guide topic for the CURRENTLY ACTIVE
// section, without changing the active section.
//
// Why the 22 files under `src/screens/cmd/sections/` are untouched (AC-11):
// admin topic ids ARE section ids, and the shell already knows the active
// `section`, so the `?` is a one-line lookup by section id — no per-section
// wiring exists to add.
//
// Two views, one sheet:
//   - topic  → `GuideTopicBody` + a "See all pages" link;
//   - index  → the role-filtered topic list, rows open a topic in place.
// The view is RE-SEEDED from the `topicId` prop on every visible false→true
// transition (an effect, not a remount — §10), so reopening the sheet on a
// different section never shows the previous section's topic.
//
// An unknown (or role-gated) id resolves to nothing and this component falls
// back to the index rather than throwing — the deep-link-safety contract.

import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { mono, Type } from '../../theme/typography';
import { useT } from '../../hooks/useT';
import { useIsMaster, useIsSuperAdmin } from '../../hooks/useRole';
import { visibleGuideTopics, type GuideTopic } from '../../lib/guide';
import { GuideTopicBody } from './GuideTopicBody';
import { ResponsiveSheet } from './ResponsiveSheet';

interface GuideSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The shell's active section id. `null` / unknown → the index. */
  topicId: string | null;
}

export const GuideSheet: React.FC<GuideSheetProps> = ({ visible, onClose, topicId }) => {
  const C = useCmdColors();
  const T = useT();
  const isMaster = useIsMaster();
  const isSuperAdmin = useIsSuperAdmin();

  const topics = React.useMemo(
    () => visibleGuideTopics('admin', { isMaster, isSuperAdmin }),
    [isMaster, isSuperAdmin],
  );

  // The topic the sheet is currently showing; null = the index view.
  const [shown, setShown] = React.useState<GuideTopic | null>(null);

  // Re-seed on every closed→open transition (NOT on every render, or picking a
  // different topic inside the sheet would snap straight back).
  const wasVisible = React.useRef(false);
  React.useEffect(() => {
    if (visible && !wasVisible.current) {
      // Seed from the ROLE-FILTERED list, not the ungated `findGuideTopic`, so
      // the seed path and the index view below share exactly one gate
      // (security review, Low #1 — defense in depth: `section` is already fed
      // only by the role-filtered sidebar, so a gated id is not reachable
      // today). A miss still falls back to the index rather than throwing,
      // which is the same deep-link-safety contract as before.
      setShown(topics.find((t) => t.id === topicId) ?? null);
    }
    wasVisible.current = visible;
  }, [visible, topicId, topics]);

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
      <Text style={[Type.caption, { color: C.fg }]}>{T('guide.title')}</Text>
      <TouchableOpacity
        testID="cmd-guide-sheet-close"
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
      accessibilityLabel={T('guide.title')}
      header={header}
    >
      {/* ResponsiveSheet takes no testID prop (shared component — not extended
          here); the AC-7 handle lives on this inner root instead. */}
      <View testID="cmd-guide-sheet" style={{ flex: 1, minHeight: 0 }}>
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 32 }}>
          {shown ? (
            <>
              <GuideTopicBody topic={shown} />
              <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
                <TouchableOpacity
                  testID="cmd-guide-sheet-see-all"
                  onPress={() => setShown(null)}
                  accessibilityRole="button"
                  activeOpacity={0.85}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text style={{ fontFamily: mono(500), fontSize: 12, color: C.accent }}>
                    {T('guide.seeAllPages')} →
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View testID="cmd-guide-sheet-index">
              <View style={{ padding: 20, gap: 6 }}>
                <Text style={[Type.h1, { color: C.fg }]}>{T('guide.indexTitle')}</Text>
                <Text style={[Type.body, { color: C.fg2, lineHeight: 20 }]}>
                  {T('guide.intro')}
                </Text>
              </View>
              {topics.map((topic) => (
                <TouchableOpacity
                  key={topic.id}
                  testID={`cmd-guide-index-${topic.id}`}
                  onPress={() => setShown(topic)}
                  accessibilityRole="button"
                  activeOpacity={0.85}
                  style={{
                    minHeight: 44,
                    justifyContent: 'center',
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderTopWidth: 1,
                    borderTopColor: C.border,
                    gap: 3,
                  }}
                >
                  <Text style={[Type.h2, { color: C.fg }]} numberOfLines={2}>
                    {T(`guide.${topic.key}.title`)}
                  </Text>
                  <Text style={[Type.bodySm, { color: C.fg3 }]} numberOfLines={2}>
                    {T(`guide.${topic.key}.purpose`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </ResponsiveSheet>
  );
};
