import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import {
  entryKey,
  fetchSchedule,
  toSections,
  type ScheduleEntry,
} from '../../services/schedule';
import { useI18n } from '../../context/LocaleContext';
import { formatDayHeading, formatTimeRange } from '../../i18n/format';
import { useColumnLayout } from '../../layout/responsive';

/**
 * Student weekly schedule: lessons and meals, in the order they are lived.
 *
 * RLS returns the pupil's own of both — their class's lessons plus the
 * multi-class and elective ones they attend, and their class's meal. The
 * fetching, merging and grouping are in services/schedule.ts, where the test
 * runner can reach them; jest.config.js renders no screens by design, and this
 * screen going a whole feature without a line of lunch code is what that costs
 * when the logic lives here instead.
 */

const DAYS_AHEAD = 7;

export function StudentScheduleScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<ScheduleEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { gutter } = useColumnLayout();

  const load = useCallback(async () => {
    try {
      setRows(await fetchSchedule());
      setError(null);
    } catch {
      setError(t('common.loadError'));
    }
  }, [t]);

  useEffect(() => {
    void load().finally(() => setIsLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const sections = useMemo(
    () =>
      toSections(rows).map((section) => ({
        ...section,
        // The label is derived here and the section is keyed on the date, not on
        // this string: two days can render the same label under a locale that
        // omits the year, and a SectionList given two sections with one key
        // drops one of them.
        title: formatDayHeading(section.date, locale),
      })),
    [rows, locale],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <Text style={styles.headerTitle}>{t('studentSchedule.title')}</Text>
        <Text style={styles.headerSubtitle}>{t('schedule.nextDays', { count: DAYS_AHEAD })}</Text>
      </View>
      {error ? <Text style={[styles.errorText, { paddingHorizontal: gutter }]}>{error}</Text> : null}
      <SectionList
        sections={sections}
        keyExtractor={entryKey}
        contentContainerStyle={{ paddingHorizontal: gutter }}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          if (item.kind === 'RAST') {
            return (
              <View style={[styles.card, styles.cardRast]}>
                <Text style={styles.cardTitleRast}>{item.name}</Text>
                <Text style={styles.cardMeta}>{formatTimeRange(item.startsAt, item.endsAt)}</Text>
              </View>
            );
          }
          if (item.kind === 'LUNCH') {
            return (
              <View style={[styles.card, styles.cardLunch]}>
                <Text style={styles.cardTitleLunch}>{t('common.lunch')}</Text>
                <Text style={styles.cardMeta}>{formatTimeRange(item.startsAt, item.endsAt)}</Text>
              </View>
            );
          }
          const cancelled = item.status === 'CANCELLED';
          return (
            <View style={[styles.card, cancelled && styles.cardCancelled]}>
              <Text style={[styles.cardTitle, cancelled && styles.cancelledText]}>
                {cancelled
                  ? `${item.subject?.name ?? t('common.lesson')} · ${t('common.cancelled')}`
                  : item.subject?.name ?? t('common.lesson')}
              </Text>
              <Text style={styles.cardMeta}>
                {item.room?.name
                  ? `${formatTimeRange(item.startsAt, item.endsAt)} · ${item.room.name}`
                  : formatTimeRange(item.startsAt, item.endsAt)}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>{t('studentSchedule.empty', { count: DAYS_AHEAD })}</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { padding: 32, alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: c.text, fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  errorText: { color: c.danger, paddingHorizontal: 16, paddingBottom: 8 },
  sectionHeader: {
    color: c.textMuted,
    fontSize: 13,
    fontWeight: '700',
    // No textTransform: 'capitalize' would write "Tisdag 13 Oktober", and a
    // Swedish month takes no capital.
    paddingTop: 12,
    paddingBottom: 6,
  },
  card: {
    backgroundColor: c.surface,
    borderColor: c.borderSubtle,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  // A cancelled lesson is still read: no fade (its meta line measured 1.7–3.3:1
  // faded), the struck title in muted ink and the word on the badge say it.
  cardCancelled: { backgroundColor: c.background },
  // Muted, and amber like the web band, so the meal reads as the day's shape
  // rather than as one more thing to be somewhere for.
  cardLunch: { backgroundColor: c.lunchSurface, borderColor: c.lunchBorder },
  cardTitleLunch: { color: c.lunchText, fontWeight: '600' },
  // Quieter than the meal: several a day, and none of them is somewhere to be.
  cardRast: { backgroundColor: c.breakSurface, borderColor: c.breakBorder },
  cardTitleRast: { color: c.breakText, fontWeight: '600' },
  cardTitle: { color: c.text, fontWeight: '600' },
  cancelledText: { color: c.textMuted, textDecorationLine: 'line-through' },
  cardMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
}));
