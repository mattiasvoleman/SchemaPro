import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useSync } from '../../context/SyncContext';
import { formatTimeRange } from '../../i18n/format';
import type { Translate } from '../../i18n';
import { useBiometrics } from '../../hooks/useBiometrics';
import { useOfflineAttendance } from '../../hooks/useOfflineAttendance';
import { getStudentsByIds } from '../../services/database/localDatabase';
import type { AttendanceStatus, Student, SyncProblem, SyncStatus } from '../../types';

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

const STATUS_COLORS: Record<AttendanceStatus, string> = {
  present: '#22c55e',
  absent: '#ef4444',
  late:   '#f59e0b',
  excused: '#8b5cf6',
};

type SyncConfig = {
  readonly color: string;
  readonly dotChar: string;
};

// The words are the catalogue's (attendance.sync.*); only colour and glyph here.
const SYNC_STATUS_CONFIG: Record<SyncStatus, SyncConfig> = {
  connected: { color: '#22c55e', dotChar: '●' },
  offline:   { color: '#f59e0b', dotChar: '◌' },
  syncing:   { color: '#3b82f6', dotChar: '↻' },
  error:     { color: '#ef4444', dotChar: '✕' },
};

/** The banner's line: the status, what is waiting, and what went wrong. */
export function syncBannerText(t: Translate, status: SyncStatus, pendingCount: number, problem: SyncProblem | null): string {
  const parts = [t(`attendance.sync.${status}`)];
  if (pendingCount > 0) parts.push(t('attendance.pending', { count: pendingCount }));
  if (problem?.code === 'SESSION_EXPIRED') parts.push(t('attendance.syncErrors.SESSION_EXPIRED'));
  if (problem?.code === 'RECORDS_FAILED') parts.push(t('attendance.syncErrors.RECORDS_FAILED', { count: problem.count }));
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

function SyncBanner({ status, pendingCount, problem }: SyncBannerProps): React.JSX.Element {
  const { t } = useI18n();
  const cfg = SYNC_STATUS_CONFIG[status];

  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: `${cfg.color}22`, borderBottomColor: cfg.color },
      ]}
    >
      <Text style={[styles.bannerDot, { color: cfg.color }]}>{cfg.dotChar}</Text>
      <Text style={[styles.bannerText, { color: cfg.color }]} numberOfLines={1}>
        {syncBannerText(t, status, pendingCount, problem)}
      </Text>
    </View>
  );
}

interface StudentRowProps {
  readonly item: StudentAttendanceItem;
  readonly onStatusChange: (studentId: string, status: AttendanceStatus) => void;
}

function StudentRow({ item, onStatusChange }: StudentRowProps): React.JSX.Element {
  const { t } = useI18n();
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
                isActive && { backgroundColor: STATUS_COLORS[s], borderColor: STATUS_COLORS[s] },
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
  const { activeLesson, syncState, triggerManualSync } = useSync();
  const { authState } = useAuth();
  const { t } = useI18n();
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

  const renderItem = useCallback(
    ({ item }: { item: StudentAttendanceItem }): React.JSX.Element => (
      <StudentRow item={item} onStatusChange={handleStatusChange} />
    ),
    [handleStatusChange],
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
      <SafeAreaView style={styles.container}>
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
    <SafeAreaView style={styles.container}>
      {/* ── Status Banner ──────────────────────────────────────────────── */}
      <SyncBanner
        status={syncState.status}
        pendingCount={syncState.pendingCount}
        problem={syncState.problem}
      />

      {/* ── Lesson Header ──────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerSubject}>{activeLesson.subjectName}</Text>
        <Text style={styles.headerMeta}>
          {`${activeLesson.roomName}  ·  ${formatTimeRange(activeLesson.startTime, activeLesson.endTime)}`}
        </Text>
        <Text style={styles.headerProgress}>
          {t('attendance.recorded', { done: attendanceMap.size, total: students.length })}
        </Text>
      </View>

      {/* ── Loading overlay ────────────────────────────────────────────── */}
      {isBusy && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      )}

      {/* ── Student list (FlashList for 60 fps) ────────────────────────── */}
      <FlashList
        data={listData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={64}
        contentContainerStyle={{ paddingBottom: 110 }}
      />

      {/* ── Submit Footer ──────────────────────────────────────────────── */}
      <View style={styles.footer}>
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
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>{t('attendance.submit')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
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
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },

  // Header
  header: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e3a',
  },
  headerSubject: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e2e8f0',
    marginBottom: 4,
  },
  headerMeta: {
    fontSize: 14,
    color: '#94a3b8',
    marginBottom: 2,
  },
  headerProgress: {
    fontSize: 12,
    color: '#64748b',
  },

  // List row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e1e3a',
  },
  rowName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#e2e8f0',
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
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#2d2d4a',
  },
  statusBtnLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  statusBtnLabelActive: {
    color: '#fff',
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
    color: '#e2e8f0',
    marginBottom: 10,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#64748b',
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
    backgroundColor: 'rgba(15,15,26,0.55)',
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
    backgroundColor: '#0f0f1a',
    borderTopWidth: 1,
    borderTopColor: '#1e1e3a',
  },
  submitBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 17,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    backgroundColor: '#3730a3',
    opacity: 0.5,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
