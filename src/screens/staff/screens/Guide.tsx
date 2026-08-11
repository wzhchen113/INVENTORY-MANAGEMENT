// src/screens/staff/screens/Guide.tsx — Spec 158 §4.
//
// The staff surface gets a SCREEN, not a sheet: `ResponsiveSheet` reads
// `useCmdColors()` and is therefore an admin-surface component the staff
// subtree may not import (spec 063). The staff precedent for "a page you
// navigate to from a small header control" is spec 126's Settings, whose
// header/back shape this screen mirrors.
//
// Route param `{ topicId?: string }`:
//   - present + known → that topic's body, with a back-to-index control;
//   - absent / unknown → the 5-topic index. `findGuideTopic` returns null for
//     an unknown id and this screen falls back to the index rather than
//     throwing — the route param is caller-controlled.
//
// Role awareness (AC-15): the audience is the LITERAL 'staff' at every call
// site here. It is never threaded through a route param, a prop or a variable
// — admin topics are a different array in the model and their strings only
// exist in the admin catalog, so they are structurally unreachable from this
// surface rather than filtered out at runtime.
//
// Reads no store slice (`useStaffStore` is not imported), which is what makes
// registering this screen in BOTH StaffStack navigator branches valid.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { findGuideTopic, guideTopics, type GuideTopic } from '../../../lib/guide';
import { useI18n } from '../i18n';
import { useStaffColors, useStaffElevation, useStaffTokens, type StaffTokens } from '../theme';

export function Guide() {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const navigation = useNavigation<{ goBack: () => void }>();
  const route = useRoute<{ key: string; name: string; params?: { topicId?: string } }>();

  const topics = useMemo(() => guideTopics('staff'), []);
  const routeTopic = useMemo(
    () => findGuideTopic('staff', route.params?.topicId),
    [route.params?.topicId],
  );

  // `undefined` = "follow the route param"; a value (or null) = the user has
  // navigated inside the screen since it mounted.
  const [picked, setPicked] = useState<GuideTopic | null | undefined>(undefined);
  const shown = picked === undefined ? routeTopic : picked;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bgAlt }]}
      edges={['top', 'bottom']}
      testID="staff-guide-screen"
    >
      {/* Header — back affordance + title (mirrors Settings) */}
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          testID="staff-guide-back"
          accessibilityRole="button"
          accessibilityLabel={t('guide.back')}
          style={({ pressed }) => [
            styles.backBtn,
            pressed ? { backgroundColor: c.surfaceAlt } : null,
          ]}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ {t('guide.back')}</Text>
        </Pressable>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>
          {t('guide.title')}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollBody}>
        {shown ? (
          <>
            <View
              style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
              testID={`staff-guide-topic-${shown.id}`}
            >
              <Text style={[styles.topicTitle, { color: c.text }]}>
                {t(`guide.${shown.key}.title`)}
              </Text>

              <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
                {t('guide.purposeLabel')}
              </Text>
              <Text style={[styles.body, { color: c.textSecondary }]}>
                {t(`guide.${shown.key}.purpose`)}
              </Text>

              <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
                {t('guide.actionsLabel')}
              </Text>
              {Array.from({ length: shown.actions }, (_, i) => i + 1).map((n) => (
                <View key={n} style={styles.actionRow} testID={`staff-guide-action-${shown.id}-${n}`}>
                  <View style={[styles.marker, { backgroundColor: c.primary }]}>
                    <Text style={[styles.markerText, { color: c.textOnPrimary }]}>{n}</Text>
                  </View>
                  <Text style={[styles.actionText, { color: c.text }]}>
                    {t(`guide.${shown.key}.actions.${n}`)}
                  </Text>
                </View>
              ))}
            </View>

            <Pressable
              onPress={() => setPicked(null)}
              testID="staff-guide-see-all"
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.linkBtn,
                pressed ? { backgroundColor: c.surfaceAlt } : null,
              ]}
            >
              <Text style={[styles.linkText, { color: c.primary }]}>{t('guide.backToIndex')}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.intro} testID="staff-guide-index">
              <Text style={[styles.introTitle, { color: c.text }]}>{t('guide.indexTitle')}</Text>
              <Text style={[styles.body, { color: c.textSecondary }]}>{t('guide.intro')}</Text>
            </View>
            {topics.map((topic) => (
              <Pressable
                key={topic.id}
                onPress={() => setPicked(topic)}
                testID={`staff-guide-index-${topic.id}`}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.card,
                  styles.indexRow,
                  { backgroundColor: pressed ? c.surfaceAlt : c.surface, borderColor: c.border },
                  e.card,
                ]}
              >
                <Text style={[styles.rowTitle, { color: c.text }]} numberOfLines={2}>
                  {t(`guide.${topic.key}.title`)}
                </Text>
                <Text style={[styles.body, { color: c.textSecondary }]} numberOfLines={3}>
                  {t(`guide.${topic.key}.purpose`)}
                </Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.md,
    paddingBottom: T.spacing.md,
    borderBottomWidth: 1,
    gap: T.spacing.xs,
  },
  backBtn: {
    alignSelf: 'flex-start',
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingRight: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  backText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
  title: {
    fontSize: T.typography.headline,
    fontWeight: T.typography.bold,
  },
  scrollBody: {
    padding: T.spacing.lg,
    paddingBottom: T.spacing.xxxl,
    gap: T.spacing.lg,
  },
  intro: {
    gap: T.spacing.xs,
  },
  introTitle: {
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.bold,
  },
  card: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    padding: T.spacing.lg,
    gap: T.spacing.sm,
  },
  indexRow: {
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
  },
  rowTitle: {
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.semibold,
  },
  topicTitle: {
    fontSize: T.typography.headline,
    fontWeight: T.typography.bold,
  },
  sectionLabel: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  body: {
    fontSize: T.typography.body,
    lineHeight: T.typography.lineHeightBody,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: T.spacing.md,
  },
  marker: {
    width: T.touchTarget.min,
    height: T.touchTarget.min,
    borderRadius: T.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  markerText: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.bold,
  },
  actionText: {
    flex: 1,
    fontSize: T.typography.body,
    lineHeight: T.typography.lineHeightBody,
  },
  linkBtn: {
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  linkText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
});
