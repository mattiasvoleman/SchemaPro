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
import { getSupabase } from '../../services/supabase';

interface LessonRow {
  readonly id: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly subject: { name: string } | null;
  readonly room: { name: string } | null;
}

/**
 * Student weekly schedule. RLS returns the student's own lessons: their
 * class's, plus multi-class and elective lessons they participate in.
 */
async function fetchLessons(): Promise<LessonRow[]> {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + 7);
  const { data, error } = await getSupabase()
    .from('CalendarLessons')
    .select('id, date, startsAt, endsAt, status, subject:Subjects(name), room:Rooms(name)')
    .gte('date', from.toISOString().slice(0, 10))
    .lte('date', to.toISOString().slice(0, 10))
    .order('startsAt');
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as LessonRow[];
}

export function StudentScheduleScreen(): React.JSX.Element {
  const [rows, setRows] = useState<LessonRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchLessons());
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

  const sections = useMemo(() => {
    const byDate = new Map<string, LessonRow[]>();
    for (const row of rows) {
      const key = row.date.slice(0, 10);
      byDate.set(key, [...(byDate.get(key) ?? []), row]);
    }
    return [...byDate.entries()].map(([date, data]) => ({
      title: new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      }),
      data,
    }));
  }, [rows]);

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
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => {
          const cancelled = item.status === 'CANCELLED';
          return (
            <View style={[styles.card, cancelled && styles.cardCancelled]}>
              <Text style={[styles.cardTitle, cancelled && styles.cancelledText]}>
                {item.subject?.name ?? 'Lesson'}
                {cancelled ? ' · CANCELLED' : ''}
              </Text>
              <Text style={styles.cardMeta}>
                {new Date(item.startsAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {' – '}
                {new Date(item.endsAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {item.room?.name ? ` · ${item.room.name}` : ''}
              </Text>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No lessons in the next 7 days</Text>
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
  cardTitle: { color: '#e2e8f0', fontWeight: '600' },
  cancelledText: { textDecorationLine: 'line-through' },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
});
