import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
  SafeAreaView,
} from 'react-native';
import {
  entryKey,
  fetchSchedule,
  toSections,
  type ScheduleEntry,
} from '../../services/schedule';

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

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const timeRange = (startsAt: string, endsAt: string) =>
  `${hhmm(startsAt)} – ${hhmm(endsAt)}`;

export function StudentScheduleScreen(): React.JSX.Element {
  const [rows, setRows] = useState<ScheduleEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchSchedule());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load.');
    }
  }, []);

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
        title: new Date(`${section.date}T00:00:00`).toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        }),
      })),
    [rows],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My schedule</Text>
        <Text style={styles.headerSubtitle}>Next 7 days</Text>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <SectionList
        sections={sections}
        keyExtractor={entryKey}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          if (item.kind === 'RAST') {
            return (
              <View style={[styles.card, styles.cardRast]}>
                <Text style={styles.cardTitleRast}>{item.name}</Text>
                <Text style={styles.cardMeta}>{timeRange(item.startsAt, item.endsAt)}</Text>
              </View>
            );
          }
          if (item.kind === 'LUNCH') {
            return (
              <View style={[styles.card, styles.cardLunch]}>
                <Text style={styles.cardTitleLunch}>Lunch</Text>
                <Text style={styles.cardMeta}>{timeRange(item.startsAt, item.endsAt)}</Text>
              </View>
            );
          }
          const cancelled = item.status === 'CANCELLED';
          return (
            <View style={[styles.card, cancelled && styles.cardCancelled]}>
              <Text style={[styles.cardTitle, cancelled && styles.cancelledText]}>
                {item.subject?.name ?? 'Lesson'}
                {cancelled ? ' · CANCELLED' : ''}
              </Text>
              <Text style={styles.cardMeta}>
                {timeRange(item.startsAt, item.endsAt)}
                {item.room?.name ? ` · ${item.room.name}` : ''}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>Nothing in the next 7 days</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  center: { padding: 32, alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: '#e2e8f0', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  errorText: { color: '#f87171', paddingHorizontal: 16, paddingBottom: 8 },
  sectionHeader: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'capitalize',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  card: {
    backgroundColor: '#1a1a2e',
    borderColor: '#1e1e3a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  cardCancelled: { opacity: 0.5 },
  // Muted, and amber like the web band, so the meal reads as the day's shape
  // rather than as one more thing to be somewhere for.
  cardLunch: { backgroundColor: '#1c1a12', borderColor: '#3a3418' },
  cardTitleLunch: { color: '#fbbf24', fontWeight: '600' },
  // Quieter than the meal: several a day, and none of them is somewhere to be.
  cardRast: { backgroundColor: '#141a1c', borderColor: '#1e3038' },
  cardTitleRast: { color: '#7dd3fc', fontWeight: '600' },
  cardTitle: { color: '#e2e8f0', fontWeight: '600' },
  cancelledText: { textDecorationLine: 'line-through' },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
});
