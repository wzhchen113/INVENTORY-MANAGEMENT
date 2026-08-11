// src/components/cmd/GuideTopicBody.tsx — Spec 158 §2.
//
// The ONE renderer of a guide topic's content on the admin surface: title,
// "What this page is for" paragraph, "Key actions" bullets. `GuideSection`
// (the sidebar destination) and `GuideSheet` (the `?` affordance) both mount
// it verbatim, so there is no second copy of the layout to drift.
//
// Every string resolves through the admin catalog (`guide.` + the topic's
// catalog-relative `key`); the bullet count comes from the pure model's
// `actions` field, so a topic can never render more bullets than it declares.
//
// Presentational only: no store read, no network, no navigation.

import React from 'react';
import { Text, View } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { Type, PhoneType, mono } from '../../theme/typography';
import { useT } from '../../hooks/useT';
import { useIsPhone } from '../../theme/breakpoints';
import type { GuideTopic } from '../../lib/guide';

interface Props {
  topic: GuideTopic;
}

export const GuideTopicBody: React.FC<Props> = ({ topic }) => {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();

  // 1..N — N is the topic's declared `actions` count (AC-5).
  const actionNumbers = React.useMemo(
    () => Array.from({ length: topic.actions }, (_, i) => i + 1),
    [topic.actions],
  );

  const titleStyle = isPhone ? PhoneType.detailTitle : Type.h1;
  const bodyStyle = isPhone ? PhoneType.body : Type.body;

  return (
    <View testID={`cmd-guide-topic-${topic.id}`} style={{ gap: 16, padding: 20 }}>
      <View style={{ gap: 6 }}>
        <Text style={[Type.caption, { color: C.fg3 }]}>
          {T(`guide.groups.${topic.group}`)}
        </Text>
        <Text style={[titleStyle, { color: C.fg }]}>
          {T(`guide.${topic.key}.title`)}
        </Text>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={[Type.caption, { color: C.fg3 }]}>{T('guide.purposeLabel')}</Text>
        <Text style={[bodyStyle, { color: C.fg2, lineHeight: 20 }]}>
          {T(`guide.${topic.key}.purpose`)}
        </Text>
      </View>

      <View
        style={{
          gap: 10,
          padding: 14,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: CmdRadius.md,
          backgroundColor: C.panel,
        }}
      >
        <Text style={[Type.caption, { color: C.fg3 }]}>{T('guide.actionsLabel')}</Text>
        {actionNumbers.map((n) => (
          <View
            key={n}
            testID={`cmd-guide-action-${topic.id}-${n}`}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: CmdRadius.pill,
                backgroundColor: C.accent,
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Text style={{ fontFamily: mono(600), fontSize: 10.5, color: C.accentFg }}>{n}</Text>
            </View>
            <Text style={[bodyStyle, { color: C.fg, flex: 1, minWidth: 0, lineHeight: 20 }]}>
              {T(`guide.${topic.key}.actions.${n}`)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
};
