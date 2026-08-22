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
import { useSync } from '../../context/SyncContext';
import { getSupabase } from '../../services/supabase';
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
  readonly subjectName: string;
  readonly roomName: string;
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

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayHeading(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return parsed.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

async function fetchSchedule(teacherId: string): Promise<ScheduleRow[]> {
  const from = toDateString(new Date());
  const to = toDateString(new Date(Date.now() + DAYS_AHEAD * 86_400_000));

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
      subjectName: lesson.subject?.name ?? 'Lesson',
      roomName: lesson.room?.name ?? '—',
      studentGroupId: lesson.studentGroupId,
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * Everyone who is actually in the room, which is not the same as the class.
 *
 * A home class holds its pupils through Users.studentGroupId, but a teaching
 * group — Ma71, språkval En74 — holds none by construction: its roster lives in
 * StudentGroupMembers. Asking only the first question returned nothing for
 * every nivågrupp, so a teacher opening such a lesson to take attendance met an
 * empty list and could not report at all. The web view was given the full union
 * and this one was not; it is the same union, kept deliberately in the same
 * shape as web/lib/queries.ts useLessonRoster so the two can be read together.
 *
 * Four sources: the lesson's own class, any extra classes attending it,
 * teaching-group membership for all of those, and pupils named individually.
 */
async function fetchRoster(row: ScheduleRow): Promise<
  Array<{ id: string; firstName: string; lastName: string }>
> {
  const supabase = getSupabase();
  const [extraGroups, participants] = await Promise.all([
    supabase
      .from('CalendarLessonGroups')
      .select('studentGroupId')
      .eq('calendarLessonId', row.id),
    supabase
      .from('CalendarLessonStudents')
      .select('studentId')
      .eq('calendarLessonId', row.id),
  ]);
  if (extraGroups.error) throw new Error(extraGroups.error.message);
  if (participants.error) throw new Error(participants.error.message);

  const groupIds = [
    row.studentGroupId,
    ...(extraGroups.data ?? []).map((entry) => entry.studentGroupId as string),
  ];

  const memberships = await supabase
    .from('StudentGroupMembers')
    .select('studentId')
    .in('studentGroupId', groupIds);
  if (memberships.error) throw new Error(memberships.error.message);

  const studentIds = [
    ...new Set([
      ...(participants.data ?? []).map((entry) => entry.studentId as string),
      ...(memberships.data ?? []).map((entry) => entry.studentId as string),
    ]),
  ];

  const filters = [`studentGroupId.in.(${groupIds.join(',')})`];
  if (studentIds.length > 0) filters.push(`id.in.(${studentIds.join(',')})`);

  const { data, error } = await supabase
    .from('Users')
    .select('id, firstName, lastName')
    .eq('role', 'STUDENT')
    .eq('isActive', true)
    .or(filters.join(','))
    .order('lastName');
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; firstName: string; lastName: string }>;
}

async function cacheLessonForAttendance(row: ScheduleRow): Promise<CalendarLesson> {
  const data = await fetchRoster(row);

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
    subjectName: row.subjectName,
    roomName: row.roomName,
    studentIds: students.map((student) => student.id),
  };

  await upsertStudents(students);
  await upsertCalendarLesson(lesson);
  return lesson;
}

export function ScheduleScreen(): React.JSX.Element {
  const { authState } = useAuth();
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
      setError(err instanceof Error ? err.message : 'Could not load the schedule.');
    }
  }, [authState.teacherId]);

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
      .map(([date, data]) => ({ title: formatDayHeading(date), data }));
  }, [rows]);

  const openLesson = useCallback(
    async (row: ScheduleRow): Promise<void> => {
      setOpeningId(row.id);
      try {
        const lesson = await cacheLessonForAttendance(row);
        setActiveLesson(lesson);
        router.push('/(app)/attendance');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the lesson.');
      } finally {
        setOpeningId(null);
      }
    },
    [router, setActiveLesson],
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
        <Text style={styles.headerTitle}>My Schedule</Text>
        <Text style={styles.headerSubtitle}>Next {DAYS_AHEAD} days</Text>
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
              accessibilityLabel={`Open ${item.subjectName} for attendance`}
            >
              <View style={styles.cardTime}>
                <Text style={styles.cardTimeText}>{formatTime(item.startsAt)}</Text>
                <Text style={styles.cardTimeSub}>{formatTime(item.endsAt)}</Text>
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardSubject} numberOfLines={1}>
                  {item.subjectName}
                </Text>
                <Text style={styles.cardMeta} numberOfLines={1}>
                  {item.roomName}
                  {cancelled ? '  ·  Cancelled' : ''}
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
            <Text style={styles.emptyTitle}>No upcoming lessons</Text>
            <Text style={styles.emptySubtitle}>
              Published lessons for the next {DAYS_AHEAD} days will appear here.
            </Text>
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
