// src/screens/cmd/sections/GuideSection.tsx — Spec 158 §2.
//
// The `Guide` sidebar destination: a browsable index of every page in the
// admin Cmd UI, grouped in sidebar order, with the selected topic's body on
// the right.
//
//   - desktop / tablet: two-pane — grouped topic list on the left, the
//     selected topic's `GuideTopicBody` on the right.
//   - phone (375px):   `PhoneDrillScaffold` list → detail (spec 140-148), so
//     the list stays MOUNTED and its scroll survives back.
//
// The list is role-filtered by the same `useIsMaster()` / `useIsSuperAdmin()`
// gates the sidebar itself uses — and deliberately NOT by the user's personal
// spec-008 sidebar-hide override (see `visibleGuideTopics`).
//
// Reads no store slice, issues no network request, mutates nothing. All
// content comes from the pure `src/lib/guide.ts` model + the admin catalog.

import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCmdColors } from '../../../theme/colors';
import { Type, PhoneType } from '../../../theme/typography';
import { useT } from '../../../hooks/useT';
import { useIsPhone } from '../../../theme/breakpoints';
import { useIsMaster, useIsSuperAdmin } from '../../../hooks/useRole';
import { GuideTopicBody } from '../../../components/cmd/GuideTopicBody';
import { visibleGuideTopics, type GuideGroup, type GuideTopic } from '../../../lib/guide';
import { PhoneDrillScaffold } from './phone/PhoneDrillScaffold';
import { usePhoneDrill } from './phone/usePhoneDrill';

/** Consecutive same-group topics collapse into one captioned block, so the
 *  index reads in the same order (and with the same headings) as the nav. */
function groupTopics(topics: GuideTopic[]): Array<{ group: GuideGroup; topics: GuideTopic[] }> {
  const out: Array<{ group: GuideGroup; topics: GuideTopic[] }> = [];
  for (const topic of topics) {
    const last = out[out.length - 1];
    if (last && last.group === topic.group) last.topics.push(topic);
    else out.push({ group: topic.group, topics: [topic] });
  }
  return out;
}

interface RowProps {
  topic: GuideTopic;
  selected: boolean;
  onPress: () => void;
}

const GuideIndexRow: React.FC<RowProps> = ({ topic, selected, onPress }) => {
  const C = useCmdColors();
  const T = useT();
  return (
    <TouchableOpacity
      testID={`cmd-guide-index-${topic.id}`}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      style={{
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 16 - (selected ? 2 : 0),
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        borderLeftWidth: selected ? 2 : 0,
        borderLeftColor: C.accent,
        backgroundColor: selected ? C.accentBg : 'transparent',
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
  );
};

export default function GuideSection() {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();
  const isMaster = useIsMaster();
  const isSuperAdmin = useIsSuperAdmin();

  const topics = React.useMemo(
    () => visibleGuideTopics('admin', { isMaster, isSuperAdmin }),
    [isMaster, isSuperAdmin],
  );
  const groups = React.useMemo(() => groupTopics(topics), [topics]);

  // Desktop / tablet: the first topic is preselected so the right pane is
  // never an empty void. Phone: nothing is selected until a row is tapped
  // (spec 142 Hard Rule 7 / AC-D2), which the drill hook already enforces.
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = React.useMemo(
    () => topics.find((t) => t.id === selectedId) ?? topics[0] ?? null,
    [topics, selectedId],
  );

  const drill = usePhoneDrill<GuideTopic>();

  const header = (
    <View style={{ padding: 16, gap: 6 }}>
      <Text style={[isPhone ? PhoneType.screenTitle : Type.h1, { color: C.fg }]}>
        {T('guide.indexTitle')}
      </Text>
      <Text style={[isPhone ? PhoneType.body : Type.body, { color: C.fg2, lineHeight: 20 }]}>
        {T('guide.intro')}
      </Text>
    </View>
  );

  const indexList = (onSelect: (topic: GuideTopic) => void, selectedTopicId: string | null) => (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 32 }}>
      {header}
      {groups.map((g) => (
        <View key={g.group}>
          <View
            style={{
              paddingHorizontal: 16,
              paddingTop: 14,
              paddingBottom: 6,
              backgroundColor: C.panel,
              borderTopWidth: 1,
              borderTopColor: C.border,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
            }}
          >
            <Text style={[Type.caption, { color: C.fg3 }]}>{T(`guide.groups.${g.group}`)}</Text>
          </View>
          {g.topics.map((topic) => (
            <GuideIndexRow
              key={topic.id}
              topic={topic}
              selected={topic.id === selectedTopicId}
              onPress={() => onSelect(topic)}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );

  if (isPhone) {
    return (
      <View testID="cmd-guide-section" style={{ flex: 1, backgroundColor: C.bg, minHeight: 0 }}>
        <PhoneDrillScaffold
          testID="cmd-guide-phone"
          parentCaption={T('guide.title')}
          backLabel={T('guide.backToIndex')}
          onBack={drill.close}
          list={indexList(drill.open, drill.selected?.id ?? null)}
          detail={drill.selected ? <GuideTopicBody topic={drill.selected} /> : null}
        />
      </View>
    );
  }

  return (
    <View
      testID="cmd-guide-section"
      style={{ flex: 1, flexDirection: 'row', backgroundColor: C.bg, minHeight: 0 }}
    >
      {/* Index pane */}
      <View
        style={{
          width: 320,
          flexShrink: 0,
          minHeight: 0,
          borderRightWidth: 1,
          borderRightColor: C.border,
          backgroundColor: C.bg,
        }}
      >
        {indexList((topic) => setSelectedId(topic.id), selected?.id ?? null)}
      </View>

      {/* Topic pane */}
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {selected ? <GuideTopicBody topic={selected} /> : null}
        </ScrollView>
      </View>
    </View>
  );
}
