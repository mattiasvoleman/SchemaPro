import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useSync } from '../../context/SyncContext';
import { formatDayHeading, formatTime } from '../../i18n/format';
import { getSupabase } from '../../services/supabase';
import { openLessonForAttendance } from '../../services/roster';
import { fetchSupervisionWeek, passCardsOf, type PassCard } from '../../services/supervisionWeek';
import { useColumnLayout } from '../../layout/responsive';

// ─────────────────────────────────────────────────────────────────────────────
// Read-only schedule for the signed-in teacher.
//
// The schedule is read directly from Supabase under RLS (no gateway
// round-trip). Selecting a lesson asks the gateway for its roster and caches
// both into the encrypted local SQLite store, so the register can be taken
// offline (services/roster.ts).
//
// The teacher's rastvaktspass (Rastvakt i vardagen) come from the gateway
// beside them (services/supervisionWeek.ts) and are drawn among the lessons
// as cards that open nothing. A pass read that fails says so and costs the
// schedule none of its lessons.
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
}

interface RawLessonRow {
  readonly lesson: {
    readonly id: string;
    readonly date: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: string;
    readonly subject: { readonly name: string } | null;
    readonly room: { readonly name: string } | null;
  } | null;
}

/** The days the screen shows: today and the seven after it. */
function scheduleWindow(): { from: string; to: string } {
  return {
    from: new Date().toISOString().slice(0, 10),
    to: new Date(Date.now() + DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10),
  };
}

/** A lesson or a pass, as the list draws them. */
type ScheduleItem = { readonly kind: 'LESSON'; readonly row: ScheduleRow } | { readonly kind: 'PASS'; readonly card: PassCard };

async function fetchSchedule(teacherId: string): Promise<ScheduleRow[]> {
  const { from, to } = scheduleWindow();

  const { data, error } = await getSupabase()
    .from('CalendarLessonTeachers')
    .select(
      'lesson:CalendarLessons!inner(id, date, startsAt, endsAt, status, subject:Subjects(name), room:Rooms(name))',
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
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export function ScheduleScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { authState } = useAuth();
  const { t, locale } = useI18n();
  const { setActiveLesson } = useSync();
  const router = useRouter();

  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [passes, setPasses] = useState<PassCard[]>([]);
  const [passesFailed, setPassesFailed] = useState(false);
  /** The newest pass read: an older answer arriving late never replaces it. */
  const passRead = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const { gutter } = useColumnLayout();

  /** True when the schedule shown is the one just read. */
  const load = useCallback(async (): Promise<boolean> => {
    if (!authState.teacherId) return false;
    const { from, to } = scheduleWindow();
    // The passes beside the lessons, and never in their way: not awaited, so
    // a slow gateway keeps neither the spinner nor a refresh waiting, and
    // only the newest read lands.
    const read = ++passRead.current;
    void fetchSupervisionWeek(from, to).then(
      (fetched) => {
        if (read !== passRead.current) return;
        setPasses(passCardsOf(fetched));
        setPassesFailed(false);
      },
      () => {
        if (read !== passRead.current) return;
        setPasses([]);
        setPassesFailed(true);
      },
    );
    try {
      setError(null);
      const fetched = await fetchSchedule(authState.teacherId);
      setRows(fetched);
      return true;
    } catch (err) {
      setError(t('schedule.loadError'));
      return false;
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
    const byDate = new Map<string, ScheduleItem[]>();
    const add = (date: string, item: ScheduleItem) => byDate.set(date, [...(byDate.get(date) ?? []), item]);
    for (const row of rows) add(row.date, { kind: 'LESSON', row });
    for (const card of passes) add(card.date, { kind: 'PASS', card });
    // As instants: the lessons' times come from PostgREST (+00:00) and the
    // passes' from the gateway (Z), so the strings do not compare.
    const startOf = (item: ScheduleItem) => Date.parse(item.kind === 'LESSON' ? item.row.startsAt : item.card.startsAt);
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        key: date,
        title: formatDayHeading(date, locale),
        data: [...data].sort((a, b) => startOf(a) - startOf(b)),
      }));
  }, [rows, passes, locale]);

  const openLesson = useCallback(
    async (row: ScheduleRow): Promise<void> => {
      setOpeningId(row.id);
      try {
        // Every decision is the service's, where jest can reach it: the
        // gateway's list, the cached copy when the gateway does not answer,
        // and a refusal said only after the schedule has been read again.
        const opening = await openLessonForAttendance(
          {
            id: row.id,
            startTime: row.startsAt,
            endTime: row.endsAt,
            subjectName: row.subjectName ?? t('common.lesson'),
            roomName: row.roomName ?? t('common.noValue'),
          },
          load,
        );
        if (opening.kind === 'OPEN') {
          setActiveLesson(opening.lesson, { fromCache: opening.fromCache });
          router.push('/(app)/attendance');
        } else if (opening.message !== null) {
          setError(t(opening.message));
        }
      } catch (err) {
        // The roster arrived but could not be written to this phone.
        setError(t('schedule.openError'));
      } finally {
        setOpeningId(null);
      }
    },
    [load, router, setActiveLesson, t],
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
        <Text style={styles.headerTitle}>{t('schedule.title')}</Text>
        <Text style={styles.headerSubtitle}>{t('schedule.nextDays', { count: DAYS_AHEAD })}</Text>
      </View>

      {error !== null && <Text style={[styles.errorText, { paddingHorizontal: gutter }]}>{error}</Text>}
      {passesFailed && error === null && (
        <Text style={[styles.errorText, { paddingHorizontal: gutter }]}>{t('schedule.passesError')}</Text>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(item) => (item.kind === 'LESSON' ? item.row.id : item.card.key)}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item: entry }) => {
          if (entry.kind === 'PASS') {
            // A rastvaktspass: the place and the time, and whose it is that
            // day. Nothing to open: the card is all there is to it.
            const card = entry.card;
            // Whose it is that day first: a narrow screen cuts the site, never that.
            const meta = [card.marker ? t(card.marker) : null, card.siteName].filter(Boolean).join('  ·  ');
            // Read aloud whole: the time, the place, the site and whose it is that day.
            const spoken = [
              t('schedule.passA11y', { area: card.areaName }),
              `${formatTime(card.startsAt)}–${formatTime(card.endsAt)}`,
              meta,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <View
                style={[styles.card, styles.cardPass, card.relieved && styles.cardPassRelieved]}
                accessible
                accessibilityLabel={spoken}
              >
                <View style={styles.cardTime}>
                  <Text style={styles.cardTimeText}>{formatTime(card.startsAt)}</Text>
                  <Text style={styles.cardTimeSub}>{formatTime(card.endsAt)}</Text>
                </View>
                <View style={styles.cardBody}>
                  <Text style={styles.cardSubject} numberOfLines={1}>
                    {`${t('schedule.passTitle')}  ·  ${card.areaName}`}
                  </Text>
                  {meta ? (
                    <Text style={styles.cardMeta} numberOfLines={1}>
                      {meta}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          }
          const item = entry.row;
          const cancelled = item.status === 'CANCELLED';
          const subject = item.subjectName ?? t('common.lesson');
          // A cancelled lesson cannot be opened, so it is not offered as one:
          // a screen reader hears the subject and that it is cancelled.
          return (
            <TouchableOpacity
              style={[styles.card, cancelled && styles.cardCancelled]}
              onPress={() => void openLesson(item)}
              disabled={cancelled || openingId !== null}
              accessibilityRole="button"
              accessibilityLabel={
                cancelled ? `${subject}, ${t('common.cancelled')}` : t('schedule.openA11y', { subject })
              }
            >
              <View style={styles.cardTime}>
                <Text style={styles.cardTimeText}>{formatTime(item.startsAt)}</Text>
                <Text style={styles.cardTimeSub}>{formatTime(item.endsAt)}</Text>
              </View>
              <View style={styles.cardBody}>
                <View style={styles.subjectRow}>
                  <Text style={[styles.cardSubject, cancelled && styles.cancelledText]} numberOfLines={1}>
                    {subject}
                  </Text>
                  {cancelled ? <Text style={styles.badgeCancelled}>{t('common.cancelled')}</Text> : null}
                </View>
                <Text style={styles.cardMeta} numberOfLines={1}>
                  {item.roomName ?? t('common.noValue')}
                </Text>
              </View>
              {openingId === item.id ? (
                <ActivityIndicator color={colors.primary} />
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
        contentContainerStyle={[rows.length === 0 && passes.length === 0 ? styles.listEmpty : styles.list, { paddingHorizontal: gutter }]}
      />
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => ({
  container: {
    flex: 1,
    backgroundColor: c.background,
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
    borderBottomColor: c.borderSubtle,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
  },
  headerSubtitle: {
    fontSize: 13,
    color: c.textMuted,
    marginTop: 2,
  },
  errorText: {
    fontSize: 13,
    color: c.danger,
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
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
    paddingTop: 18,
    paddingBottom: 8,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    gap: 14,
  },
  // A cancelled lesson is still read: no fade (its meta line measured 1.7–3.3:1
  // faded). The page's ground alone is about 1.1:1 against a card, so the
  // struck subject in muted ink and the word beside it say it; the word is its
  // own text, so a long subject or a large text size truncates the subject
  // and never the word.
  cardCancelled: { backgroundColor: c.background },
  cardPass: {
    borderColor: c.warning,
    borderLeftWidth: 4,
  },
  // A pass somebody else has that day, or nobody: dashed and untinted, as
  // nothing to stand at. Not faded: the 45 % of a cancelled lesson would take
  // the text below AA. iOS draws a dashed border only at one width all round.
  cardPassRelieved: {
    borderStyle: 'dashed',
    borderWidth: 2,
    borderLeftWidth: 2,
    backgroundColor: 'transparent',
  },
  cardTime: {
    alignItems: 'center',
    minWidth: 52,
  },
  cardTimeText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
  },
  cardTimeSub: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 2,
  },
  cardBody: {
    flex: 1,
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  cardSubject: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: '600',
    color: c.text,
  },
  cancelledText: {
    color: c.textMuted,
    textDecorationLine: 'line-through',
  },
  badgeCancelled: {
    fontSize: 12,
    fontWeight: '700',
    color: c.danger,
  },
  cardMeta: {
    fontSize: 13,
    color: c.textMuted,
  },
  cardChevron: {
    fontSize: 24,
    color: c.textMuted,
    fontWeight: '300',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: c.text,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
}));
