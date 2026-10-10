import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { formatDayHeading, shiftDate } from '../../i18n/format';
import { ApiError } from '../../services/api';
import { childListState, fetchChildren, scheduleChildren } from '../../services/children';
import {
  canStep,
  familyDays,
  fetchFamilySchedule,
  lessonState,
  weekNumber,
  type FamilyDay,
  type FamilyEntry,
  type FamilySchedule,
} from '../../services/familySchedule';
import type { ChildRow } from '../../types';

/**
 * "Schema" for a guardian: each child's PUBLISHED week, as the school shows
 * it to families — the same read as the web's /guardian card
 * (services/familySchedule.ts). One child at a time, today or the whole week,
 * stepping only within the weeks the gateway answers.
 *
 * What it never shows: another family's child, a draft, a note, a cause, an
 * absence reason, or who a substitute replaces. Times are the school's HH:MM,
 * drawn as they come.
 */

type View_ = 'today' | 'week';

export function ChildScheduleScreen(): React.JSX.Element {
  const { authState } = useAuth();
  const { t, locale } = useI18n();
  const [children, setChildren] = useState<ChildRow[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [view, setView] = useState<View_>('today');
  const [week, setWeek] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<FamilySchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [childrenFailed, setChildrenFailed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // The answer that may still land on screen: a slow answer for a child or a
  // week the reader has already left must not replace the current one.
  const asked = useRef(0);

  const selected = children.find((child) => child.id === childId) ?? children[0] ?? null;

  const loadChildren = useCallback(async () => {
    if (!authState.teacherId) return;
    try {
      setChildren(scheduleChildren(await fetchChildren(authState.teacherId)));
      setChildrenFailed(false);
    } catch {
      setChildrenFailed(true);
    }
  }, [authState.teacherId]);

  const loadWeek = useCallback(async () => {
    if (!selected) return;
    const ticket = ++asked.current;
    try {
      const answer = await fetchFamilySchedule(selected.id, week);
      if (ticket !== asked.current) return;
      setSchedule(answer);
      setError(null);
    } catch (loadError) {
      if (ticket !== asked.current) return;
      setSchedule(null);
      setError(
        loadError instanceof ApiError && loadError.code === 'WEEK_OUT_OF_RANGE'
          ? t('childSchedule.weekOutOfRange')
          : t('childSchedule.loadError'),
      );
    }
  }, [selected, week, t]);

  useEffect(() => {
    void loadChildren().finally(() => setIsLoading(false));
  }, [loadChildren]);

  useEffect(() => {
    setSchedule(null);
    void loadWeek();
  }, [loadWeek]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadChildren();
    await loadWeek();
    setIsRefreshing(false);
  }, [loadChildren, loadWeek]);

  const shown = schedule && selected && schedule.student.id === selected.id ? schedule : null;
  const days = useMemo(() => (shown ? familyDays(shown) : []), [shown]);
  const todayDay = shown ? days.find((day) => day.date === shown.today) ?? null : null;

  const step = (direction: -1 | 1): void => {
    if (!shown) return;
    setView('week');
    setWeek(shiftDate(shown.week.from, 7 * direction));
  };

  const listState = childListState({ loading: isLoading, failed: childrenFailed, count: children.length });

  if (listState === 'LOADING') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      </SafeAreaView>
    );
  }

  if (!selected) {
    // A failed read says so and can be pulled to retry (common.loadError says
    // how); only a read that answered no children says none are linked.
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.center}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />}
        >
          {listState === 'FAILED' ? (
            <Text style={styles.errorText}>{t('common.loadError')}</Text>
          ) : (
            <>
              <Text style={styles.emptyTitle}>{t('guardian.noChildrenTitle')}</Text>
              <Text style={styles.emptyBody}>{t('guardian.noChildrenBody')}</Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  const body = (): React.ReactNode => {
    if (error) return <Text style={styles.errorText}>{error}</Text>;
    if (!shown) return <ActivityIndicator color="#6366f1" style={styles.spinner} />;
    if (view === 'today') {
      return todayDay ? (
        <DayBlock day={todayDay} title={formatDayHeading(todayDay.date, locale)} empty={t('childSchedule.emptyToday')} />
      ) : (
        <Text style={styles.emptyBody}>{t('childSchedule.emptyToday')}</Text>
      );
    }
    if (days.every((day) => day.entries.length === 0)) {
      return <Text style={styles.emptyBody}>{t('childSchedule.emptyWeek')}</Text>;
    }
    return days.map((day) => (
      <DayBlock key={day.date} day={day} title={formatDayHeading(day.date, locale)} empty={t('childSchedule.emptyDay')} />
    ));
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />}
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{t('childSchedule.title', { name: selected.firstName })}</Text>
          <Text style={styles.headerSubtitle}>{t('childSchedule.body')}</Text>
        </View>

        {children.length > 1 ? (
          <View style={styles.chipRow}>
            {children.map((child) => (
              <TouchableOpacity
                key={child.id}
                accessibilityRole="button"
                accessibilityState={{ selected: child.id === selected.id }}
                onPress={() => setChildId(child.id)}
                style={[styles.chip, child.id === selected.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, child.id === selected.id && styles.chipTextActive]}>
                  {child.firstName}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <View style={styles.chipRow}>
          {(['today', 'week'] as const).map((value) => (
            <TouchableOpacity
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: view === value }}
              onPress={() => {
                setView(value);
                if (value === 'today') setWeek(null);
              }}
              style={[styles.chip, view === value && styles.chipActive]}
            >
              <Text style={[styles.chipText, view === value && styles.chipTextActive]}>
                {t(value === 'today' ? 'childSchedule.today' : 'childSchedule.week')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {view === 'week' && shown ? (
          <View style={styles.stepper}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('childSchedule.previousWeek')}
              accessibilityState={{ disabled: !canStep(shown, -1) }}
              disabled={!canStep(shown, -1)}
              onPress={() => step(-1)}
              style={[styles.stepButton, !canStep(shown, -1) && styles.stepDisabled]}
            >
              <Text style={styles.stepText}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.weekLabel}>{t('childSchedule.weekLabel', { week: weekNumber(shown.week.isoWeek) })}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('childSchedule.nextWeek')}
              accessibilityState={{ disabled: !canStep(shown, 1) }}
              disabled={!canStep(shown, 1)}
              onPress={() => step(1)}
              style={[styles.stepButton, !canStep(shown, 1) && styles.stepDisabled]}
            >
              <Text style={styles.stepText}>›</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.body}>{body()}</View>
        <View style={styles.footerSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

function DayBlock({ day, title, empty }: { day: FamilyDay; title: string; empty: string }): React.JSX.Element {
  return (
    <View style={styles.day}>
      <Text style={styles.dayTitle}>{title}</Text>
      {day.entries.length === 0 ? (
        <Text style={styles.emptyBody}>{empty}</Text>
      ) : (
        day.entries.map((entry) => <EntryRow key={entry.key} entry={entry} />)
      )}
    </View>
  );
}

function EntryRow({ entry }: { entry: FamilyEntry }): React.JSX.Element {
  const { t } = useI18n();
  const time = `${entry.start}–${entry.end}`;
  if (entry.kind !== 'LESSON') {
    return (
      <View style={[styles.card, entry.kind === 'LUNCH' ? styles.cardLunch : styles.cardRast]}>
        <Text style={entry.kind === 'LUNCH' ? styles.cardTitleLunch : styles.cardTitleRast}>
          {entry.kind === 'LUNCH' ? t('common.lunch') : entry.name}
        </Text>
        <Text style={styles.cardMeta}>{time}</Text>
      </View>
    );
  }
  const { lesson } = entry;
  const state = lessonState(lesson);
  const details = [time, lesson.room, ...lesson.teachers].filter((part): part is string => Boolean(part));
  return (
    <View style={[styles.card, state === 'cancelled' && styles.cardCancelled]}>
      <View style={styles.titleRow}>
        <View style={[styles.dot, { backgroundColor: lesson.subjectColor ?? '#6366f1' }]} />
        <Text style={[styles.cardTitle, state === 'cancelled' && styles.cancelledText]}>{lesson.subject}</Text>
        {state === 'cancelled' ? <Text style={styles.badgeCancelled}>{t('common.cancelled')}</Text> : null}
        {state === 'substitute' ? <Text style={styles.badgeSubstitute}>{t('childSchedule.substitute')}</Text> : null}
      </View>
      <Text style={styles.cardMeta}>{details.join(' · ')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  center: { padding: 32, alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: '#e2e8f0', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  errorText: { color: '#f87171', paddingHorizontal: 16, paddingBottom: 8 },
  spinner: { marginTop: 24 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  chip: { borderColor: '#2d2d4a', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipActive: { backgroundColor: '#6366f1', borderColor: '#6366f1' },
  chipText: { color: '#94a3b8', fontSize: 13 },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  stepButton: { borderColor: '#2d2d4a', borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 4 },
  stepDisabled: { opacity: 0.35 },
  stepText: { color: '#e2e8f0', fontSize: 20 },
  weekLabel: { color: '#e2e8f0', fontWeight: '600', minWidth: 80, textAlign: 'center' },
  body: { paddingTop: 8 },
  day: { paddingTop: 8 },
  dayTitle: { color: '#94a3b8', fontSize: 13, fontWeight: '700', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  card: {
    backgroundColor: '#1a1a2e',
    borderColor: '#1e1e3a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  cardCancelled: { opacity: 0.6 },
  cardLunch: { backgroundColor: '#1c1a12', borderColor: '#3a3418' },
  cardTitleLunch: { color: '#fbbf24', fontWeight: '600' },
  cardRast: { backgroundColor: '#141a1c', borderColor: '#1e3038' },
  cardTitleRast: { color: '#7dd3fc', fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardTitle: { color: '#e2e8f0', fontWeight: '600' },
  cancelledText: { textDecorationLine: 'line-through' },
  badgeCancelled: { color: '#f87171', fontSize: 12, fontWeight: '700' },
  badgeSubstitute: { color: '#fbbf24', fontSize: 12, fontWeight: '700' },
  cardMeta: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  emptyBody: { color: '#94a3b8', paddingHorizontal: 16, paddingBottom: 8 },
  footerSpace: { height: 32 },
});
