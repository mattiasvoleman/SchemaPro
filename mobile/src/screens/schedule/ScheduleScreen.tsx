import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { sortByDisplayName } from '../../utils/sorting';
import {
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useSync } from '../../context/SyncContext';
import { formatDayHeading, formatTime } from '../../i18n/format';
import { getSupabase } from '../../services/supabase';
import { fetchRoster } from '../../services/roster';
import { upsertCalendarLesson, upsertStudents } from '../../services/database/localDatabase';
import type { CalendarLesson } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Read-only schedule for the signed-in teacher.
//
// Reads flow directly from Supabase under RLS (no gateway round-trip) and are
// cached into the encrypted local SQLite store, so a lesson opened here can be
// taken offline later. Selecting a lesson also caches its roster.
// ─────────────────────────────────────────────────────────────────────────────

const DAYS_AHEAD = 7;

interface ScheduleRow {
  readonly id: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  /** Null when the lesson has no subject; the screen says "Lesson" in the reader's language. */
  readonly subjectName: string | null;
  readonly roomName: string | null;
  readonly studentGroupId: string;
}

interface RawLessonRow {
  readonly lesson: {
    readonly id: string;
    readonly date: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: string;
    readonly studentGroupId: string;
    readonly subject: { readonly name: string } | null;
    readonly room: { readonly name: string } | null;
  } | null;
}

async function fetchSchedule(teacherId: string): Promise<ScheduleRow[]> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await getSupabase()
    .from('CalendarLessonTeachers')
    .select(
      'lesson:CalendarLessons!inner(id, date, startsAt, endsAt, status, studentGroupId, subject:Subjects(name), room:Rooms(name))',
    )
    .eq('teacherId', teacherId)
    .gte('lesson.date', from)
    .lte('lesson.date', to);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as RawLessonRow[];
  return rows
    .flatMap((row) => (row.lesson ? [row.lesson] : []))
    .map((lesson) => ({
      id: lesson.id,
      date: lesson.date,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      status: lesson.status,
      subjectName: lesson.subject?.name ?? null,
      roomName: lesson.room?.name ?? null,
      studentGroupId: lesson.studentGroupId,
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

async function cacheLessonForAttendance(
  row: ScheduleRow,
  fallback: { subject: string; room: string },
): Promise<CalendarLesson> {
  const data = await fetchRoster(row.id, row.studentGroupId);

  const students = sortByDisplayName(
    data.map((student) => ({
      id: student.id as string,
      // displayName stays on-device only (encrypted SQLite) — never sent to APIs.
      displayName: `${student.firstName as string} ${student.lastName as string}`,
      photoUri: null,
    })),
  );

  const lesson: CalendarLesson = {
    id: row.id,
    startTime: row.startsAt,
    endTime: row.endsAt,
    subjectName: row.subjectName ?? fallback.subject,
    roomName: row.roomName ?? fallback.room,
    studentIds: students.map((student) => student.id),
  };

  await upsertStudents(students);
  await upsertCalendarLesson(lesson);
  return lesson;
}

export function ScheduleScreen(): React.JSX.Element {
  const { authState } = useAuth();
  const { t, locale } = useI18n();
  const { setActiveLesson } = useSync();
  const router = useRouter();

  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!authState.teacherId) return;
    try {
      setError(null);
      const fetched = await fetchSchedule(authState.teacherId);
      setRows(fetched);
    } catch (err) {
      setError(t('schedule.loadError'));
    }
  }, [authState.teacherId, t]);

  useEffect(() => {
    void load().finally(() => setIsLoading(false));
  }, [load]);

  const onRefresh = useCallback((): void => {
    setIsRefreshing(true);
    void load().finally(() => setIsRefreshing(false));
  }, [load]);

  const sections = useMemo(() => {
    const byDate = new Map<string, ScheduleRow[]>();
    for (const row of rows) {
      const list = byDate.get(row.date) ?? [];
      list.push(row);
      byDate.set(row.date, list);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ key: date, title: formatDayHeading(date, locale), data }));
  }, [rows, locale]);

  const openLesson = useCallback(
    async (row: ScheduleRow): Promise<void> => {
      setOpeningId(row.id);
      try {
        const lesson = await cacheLessonForAttendance(row, {
          subject: t('common.lesson'),
          room: t('common.noValue'),
        });
        setActiveLesson(lesson);
        router.push('/(app)/attendance');
      } catch (err) {
        setError(t('schedule.openError'));
      } finally {
        setOpeningId(null);
      }
    },
    [router, setActiveLesson, t],
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
        <Text style={styles.headerTitle}>{t('schedule.title')}</Text>
        <Text style={styles.headerSubtitle}>{t('schedule.nextDays', { count: DAYS_AHEAD })}</Text>
      </View>

      {error !== null && <Text style={styles.errorText}>{error}</Text>}

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
            <TouchableOpacity
              style={[styles.card, cancelled && styles.cardCancelled]}
              onPress={() => void openLesson(item)}
              disabled={cancelled || openingId !== null}
              accessibilityRole="button"
              accessibilityLabel={t('schedule.openA11y', { subject: item.subjectName ?? t('common.lesson') })}
            >
              <View style={styles.cardTime}>
                <Text style={styles.cardTimeText}>{formatTime(item.startsAt)}</Text>
                <Text style={styles.cardTimeSub}>{formatTime(item.endsAt)}</Text>
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardSubject} numberOfLines={1}>
                  {item.subjectName ?? t('common.lesson')}
                </Text>
                <Text style={styles.cardMeta} numberOfLines={1}>
                  {cancelled
                    ? `${item.roomName ?? t('common.noValue')}  ·  ${t('common.cancelled')}`
                    : item.roomName ?? t('common.noValue')}
                </Text>
              </View>
              {openingId === item.id ? (
                <ActivityIndicator color="#6366f1" />
              ) : (
                <Text style={styles.cardChevron}>›</Text>
              )}
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>{t('schedule.emptyTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('schedule.emptyBody', { count: DAYS_AHEAD })}</Text>
          </View>
        }
        contentContainerStyle={rows.length === 0 ? styles.listEmpty : styles.list}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingVertical: 60,
  },
  header: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e3a',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2,
  },
  errorText: {
    fontSize: 13,
    color: '#f87171',
    textAlign: 'center',
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  list: {
    paddingBottom: 24,
  },
  listEmpty: {
    flexGrow: 1,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 8,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 14,
    marginBottom: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#2d2d4a',
    gap: 14,
  },
  cardCancelled: {
    opacity: 0.45,
  },
  cardTime: {
    alignItems: 'center',
    minWidth: 52,
  },
  cardTimeText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  cardTimeSub: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2,
  },
  cardBody: {
    flex: 1,
  },
  cardSubject: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e2e8f0',
    marginBottom: 2,
  },
  cardMeta: {
    fontSize: 13,
    color: '#94a3b8',
  },
  cardChevron: {
    fontSize: 24,
    color: '#475569',
    fontWeight: '300',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#e2e8f0',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 22,
  },
});
