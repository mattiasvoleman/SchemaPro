import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { FlashList } from '@shopify/flash-list';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useSync } from '../../context/SyncContext';
import { formatDateTime, formatTimeRange } from '../../i18n/format';
import type { Translate } from '../../i18n';
import { useBiometrics } from '../../hooks/useBiometrics';
import { useOfflineAttendance } from '../../hooks/useOfflineAttendance';
import { getStudentsByIds } from '../../services/database/localDatabase';
import type { AttendanceStatus, Student, SyncProblem, SyncStatus } from '../../types';
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { FORM_MAX, REGISTER_MAX, useColumnLayout, widthClass } from '../../layout/responsive';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StudentAttendanceItem {
  readonly student: Student;
  readonly status: AttendanceStatus | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['present', 'absent', 'late', 'excused'] as const satisfies readonly AttendanceStatus[];

/** One meaning per colour, as the web's ATTENDANCE_STATUS_VARIANT: excused is information. */
const STATUS_TONE: Record<AttendanceStatus, Tone> = {
  present: 'success',
  absent: 'danger',
  late: 'warning',
  excused: 'neutral',
};

type SyncConfig = {
  readonly tone: Tone;
  readonly dotChar: string;
};

// The words are the catalogue's (attendance.sync.*); only tone and glyph here.
const SYNC_STATUS_CONFIG: Record<SyncStatus, SyncConfig> = {
  connected: { tone: 'success', dotChar: '●' },
  offline:   { tone: 'warning', dotChar: '◌' },
  syncing:   { tone: 'neutral', dotChar: '↻' },
  error:     { tone: 'danger', dotChar: '✕' },
};

/** The banner's line: the status, what is waiting, and what went wrong. */
export function syncBannerText(t: Translate, status: SyncStatus, pendingCount: number, problem: SyncProblem | null): string {
  const parts = [t(`attendance.sync.${status}`)];
  if (pendingCount > 0) parts.push(t('attendance.pending', { count: pendingCount }));
  if (problem?.code === 'SESSION_EXPIRED') parts.push(t('attendance.syncErrors.SESSION_EXPIRED'));
  if (problem?.code === 'RECORDS_FAILED') parts.push(t('attendance.syncErrors.RECORDS_FAILED', { count: problem.count }));
  if (problem?.code === 'RECORDS_REFUSED') parts.push(t('attendance.syncErrors.RECORDS_REFUSED', { count: problem.count }));
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface SyncBannerProps {
  readonly status: SyncStatus;
  readonly pendingCount: number;
  readonly problem: SyncProblem | null;
}

/**
 * The refused lessons, named, and what the teacher can do: look at the
 * register on the web (or ask an administrator, when the lesson is gone or no
 * longer theirs), then discard them from this phone. Nothing else ever clears
 * them, since the server will never take them.
 */
function useRefusedPrompt() {
  const { t, locale } = useI18n();
  const { refusedLessons, discardRefused } = useSync();
  return useCallback(async (): Promise<void> => {
    const lessons = await refusedLessons();
    const named = lessons
      .map((lesson) =>
        t('attendance.refused.lesson', {
          lesson: lesson.subjectName && lesson.startTime
            ? `${lesson.subjectName} ${formatDateTime(lesson.startTime, locale)}`
            : t('attendance.refused.unknownLesson', { marked: formatDateTime(lesson.markedAt, locale) }),
          count: lesson.count,
        }),
      )
      .join('\n');
    Alert.alert(t('attendance.refused.title'), t('attendance.refused.body', { lessons: named }), [
      { text: t('attendance.refused.keep'), style: 'cancel' },
      {
        text: t('attendance.refused.discard'),
        style: 'destructive',
        onPress: () => void discardRefused(lessons.map((lesson) => lesson.lessonId)),
      },
    ]);
  }, [t, locale, refusedLessons, discardRefused]);
}

function SyncBanner({ status, pendingCount, problem }: SyncBannerProps): React.JSX.Element {
  const { t } = useI18n();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const cfg = SYNC_STATUS_CONFIG[status];
  const promptRefused = useRefusedPrompt();
  // The tone is the tint, the edge and the glyph; the words stay in the
  // running ink (DESIGN.md, The Ink Stays Foreground Rule).
  const ground = { backgroundColor: colors.toneTint[cfg.tone], borderBottomColor: colors[cfg.tone] };
  const glyph = { color: colors[cfg.tone] };

  if (problem?.code === 'RECORDS_REFUSED') {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityHint={t('attendance.refused.hint')}
        onPress={() => void promptRefused()}
        style={[styles.banner, ground]}
      >
        <Text style={[styles.bannerDot, glyph]}>{cfg.dotChar}</Text>
        <Text style={styles.bannerText} numberOfLines={3}>
          {syncBannerText(t, status, pendingCount, problem)}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View
      style={[styles.banner, ground]}
    >
      <Text style={[styles.bannerDot, glyph]}>{cfg.dotChar}</Text>
      <Text style={styles.bannerText} numberOfLines={problem ? 3 : 1}>
        {syncBannerText(t, status, pendingCount, problem)}
      </Text>
    </View>
  );
}

interface StudentRowProps {
  readonly item: StudentAttendanceItem;
  readonly onStatusChange: (studentId: string, status: AttendanceStatus) => void;
  /** 44 pt buttons where there is room (Apple's minimum target); the phone keeps 38. */
  readonly large: boolean;
}

function StudentRow({ item, onStatusChange, large }: StudentRowProps): React.JSX.Element {
  const { t } = useI18n();
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowName} numberOfLines={1}>
        {item.student.displayName}
      </Text>
      <View style={styles.rowButtons}>
        {STATUS_OPTIONS.map((s) => {
          const isActive = item.status === s;
          return (
            <TouchableOpacity
              key={s}
              style={[
                styles.statusBtn,
                large && styles.statusBtnLarge,
                isActive && { backgroundColor: colors[STATUS_TONE[s]], borderColor: colors[STATUS_TONE[s]] },
              ]}
              onPress={() => onStatusChange(item.student.id, s)}
              accessibilityRole="button"
              accessibilityLabel={t('attendance.markA11y', {
                name: item.student.displayName,
                status: t(`attendance.statusName.${s}`),
              })}
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.statusBtnLabel, isActive && styles.statusBtnLabelActive]}>
                {t(`attendance.statusLetter.${s}`)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AttendanceScreen — the primary teacher interface for recording attendance.
 *
 * Architecture:
 *  - Student list is rendered with FlashList for 60 fps at any roster size.
 *  - All state changes write to the local SQLite queue (offline-safe).
 *  - FaceID / TouchID is required immediately before submitting.
 *  - The sync banner reflects live connection state from SyncContext.
 */
export function AttendanceScreen(): React.JSX.Element {
  const { activeLesson, activeLessonFromCache, syncState, triggerManualSync } = useSync();
  const { authState } = useAuth();
  const { t } = useI18n();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { authenticate, isAuthenticating } = useBiometrics();
  const { enqueue, isSubmitting } = useOfflineAttendance();

  const [students, setStudents] = useState<Student[]>([]);
  const [isLoadingRoster, setIsLoadingRoster] = useState(false);
  const [attendanceMap, setAttendanceMap] = useState<Map<string, AttendanceStatus>>(new Map());
  const [isBiometricPending, setIsBiometricPending] = useState(false);

  // Load students from the local cache whenever the active lesson changes.
  useEffect(() => {
    if (!activeLesson) {
      setStudents([]);
      setAttendanceMap(new Map());
      return;
    }

    setIsLoadingRoster(true);
    void getStudentsByIds(activeLesson.studentIds).then((fetched) => {
      setStudents(fetched);
      setIsLoadingRoster(false);
    });
  }, [activeLesson]);

  const listData = useMemo<StudentAttendanceItem[]>(
    () =>
      students.map((student) => ({
        student,
        status: attendanceMap.get(student.id) ?? null,
      })),
    [students, attendanceMap],
  );

  const handleStatusChange = useCallback((studentId: string, status: AttendanceStatus): void => {
    setAttendanceMap((prev) => new Map(prev).set(studentId, status));
  }, []);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!activeLesson || !authState.teacherId) return;

    const unrecorded = students.filter((s) => !attendanceMap.has(s.id));
    if (unrecorded.length > 0) {
      Alert.alert(
        t('attendance.incompleteTitle'),
        t('attendance.incompleteBody', { count: unrecorded.length }),
      );
      return;
    }

    // ── Biometric gate ──────────────────────────────────────────────────────
    setIsBiometricPending(true);
    const verified = await authenticate({
      reason: t('attendance.biometricReason'),
      cancelLabel: t('common.cancel'),
    });
    setIsBiometricPending(false);

    if (!verified) {
      Alert.alert(t('attendance.authRequiredTitle'), t('attendance.authRequiredBody'));
      return;
    }

    // ── Write to local queue ────────────────────────────────────────────────
    try {
      const teacherId = authState.teacherId;
      await Promise.all(
        Array.from(attendanceMap.entries()).map(([studentId, status]) =>
          enqueue(activeLesson.id, studentId, status, teacherId),
        ),
      );

      // Immediately attempt to push the queue if online.
      await triggerManualSync();

      Alert.alert(t('attendance.submittedTitle'), t('attendance.submittedBody'));
      setAttendanceMap(new Map());
    } catch {
      Alert.alert(t('attendance.errorTitle'), t('attendance.submitFailed'));
    }
  }, [activeLesson, authState.teacherId, students, attendanceMap, authenticate, enqueue, triggerManualSync, t]);

  const { width } = useWindowDimensions();
  const large = widthClass(width) !== 'compact';
  const { gutter } = useColumnLayout(REGISTER_MAX);
  const renderItem = useCallback(
    ({ item }: { item: StudentAttendanceItem }): React.JSX.Element => (
      <StudentRow item={item} onStatusChange={handleStatusChange} large={large} />
    ),
    [handleStatusChange, large],
  );

  const keyExtractor = useCallback(
    (item: StudentAttendanceItem): string => item.student.id,
    [],
  );

  const isBusy = isLoadingRoster || isSubmitting || isAuthenticating || isBiometricPending;
  const allRecorded = students.length > 0 && attendanceMap.size === students.length;

  // ── Empty / no-lesson state ─────────────────────────────────────────────
  if (!activeLesson) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <SyncBanner
          status={syncState.status}
          pendingCount={syncState.pendingCount}
          problem={syncState.problem}
        />
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>{t('attendance.noLessonTitle')}</Text>
          <Text style={styles.emptySubtitle}>{t('attendance.noLessonBody')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      {/* ── Status Banner ──────────────────────────────────────────────── */}
      <SyncBanner
        status={syncState.status}
        pendingCount={syncState.pendingCount}
        problem={syncState.problem}
      />

      {/* ── Lesson Header ──────────────────────────────────────────────── */}
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <Text style={styles.headerSubject}>{activeLesson.subjectName}</Text>
        <Text style={styles.headerMeta}>
          {`${activeLesson.roomName}  ·  ${formatTimeRange(activeLesson.startTime, activeLesson.endTime)}`}
        </Text>
        <Text style={styles.headerProgress}>
          {t('attendance.recorded', { done: attendanceMap.size, total: students.length })}
        </Text>
        {activeLessonFromCache && (
          <Text style={styles.headerCached}>{t('attendance.cachedList')}</Text>
        )}
      </View>

      {/* ── Loading overlay ────────────────────────────────────────────── */}
      {isBusy && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {/* ── Student list (FlashList for 60 fps) ────────────────────────── */}
      <FlashList
        data={listData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={{ paddingBottom: 110, paddingHorizontal: gutter }}
      />

      {/* ── Submit Footer ──────────────────────────────────────────────── */}
      <View style={styles.footer}>
        <View style={styles.footerColumn}>
          <TouchableOpacity
            style={[
              styles.submitBtn,
              (!allRecorded || isBusy) && styles.submitBtnDisabled,
            ]}
            onPress={() => { void handleSubmit(); }}
            disabled={!allRecorded || isBusy}
            accessibilityRole="button"
            accessibilityLabel={t('attendance.submitA11y')}
            accessibilityState={{ disabled: !allRecorded || isBusy }}
          >
            {isBiometricPending ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.submitBtnText}>{t('attendance.submit')}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const useStyles = makeStyles((c) => ({
  container: {
    flex: 1,
    backgroundColor: c.background,
  },

  // Banner
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    gap: 8,
  },
  bannerDot: {
    fontSize: 13,
    fontWeight: '700',
  },
  bannerText: {
    color: c.text,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },

  // Header
  header: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  headerSubject: {
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
    marginBottom: 4,
  },
  headerMeta: {
    fontSize: 14,
    color: c.textMuted,
    marginBottom: 2,
  },
  headerProgress: {
    fontSize: 12,
    color: c.textMuted,
  },
  headerCached: {
    fontSize: 12,
    color: c.warning,
    marginTop: 6,
  },

  // List row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.borderSubtle,
  },
  rowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: c.text,
    marginRight: 12,
  },
  rowButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  statusBtn: {
    width: 38,
    height: 38,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  statusBtnLarge: { width: 44, height: 44 },
  statusBtnLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
  },
  statusBtnLabelActive: {
    color: c.onTone,
  },

  // Empty state
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 36,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: c.text,
    marginBottom: 10,
  },
  emptySubtitle: {
    maxWidth: FORM_MAX,
    fontSize: 14,
    color: c.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Loading overlay
  loadingOverlay: {
    // StyleSheet.absoluteFillObject was removed from the RN 0.86 types.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: c.scrim,
    zIndex: 10,
  },

  // Footer
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 18,
    paddingBottom: 32,
    paddingTop: 12,
    backgroundColor: c.background,
    borderTopWidth: 1,
    borderTopColor: c.borderSubtle,
  },
  footerColumn: { width: '100%', maxWidth: FORM_MAX, alignSelf: 'center' },
  submitBtn: {
    backgroundColor: c.primary,
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: DISABLED_OPACITY,
  },
  submitBtnText: {
    color: c.onPrimary,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
}));
