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
import { useSync } from '../../context/SyncContext';
import { useBiometrics } from '../../hooks/useBiometrics';
import { useOfflineAttendance } from '../../hooks/useOfflineAttendance';
import { getStudentsByIds } from '../../services/database/localDatabase';
import type { AttendanceStatus, Student, SyncStatus } from '../../types';

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

const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'P',
  absent:  'A',
  late:    'L',
  excused: 'E',
};

type SyncConfig = {
  readonly label: string;
  readonly color: string;
  readonly dotChar: string;
};

const SYNC_STATUS_CONFIG: Record<SyncStatus, SyncConfig> = {
  connected: { label: 'Connected',              color: '#22c55e', dotChar: '●' },
  offline:   { label: 'Offline · cached data',  color: '#f59e0b', dotChar: '◌' },
  syncing:   { label: 'Syncing…',               color: '#3b82f6', dotChar: '↻' },
  error:     { label: 'Sync Error',             color: '#ef4444', dotChar: '✕' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface SyncBannerProps {
  readonly status: SyncStatus;
  readonly pendingCount: number;
  readonly errorMessage: string | null;
}

function SyncBanner({ status, pendingCount, errorMessage }: SyncBannerProps): React.JSX.Element {
  const cfg = SYNC_STATUS_CONFIG[status];
  const pendingLabel = pendingCount > 0 ? ` · ${pendingCount} pending` : '';
  const errLabel = errorMessage ? ` · ${errorMessage}` : '';

  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: `${cfg.color}22`, borderBottomColor: cfg.color },
      ]}
    >
      <Text style={[styles.bannerDot, { color: cfg.color }]}>{cfg.dotChar}</Text>
      <Text style={[styles.bannerText, { color: cfg.color }]} numberOfLines={1}>
        {cfg.label}{pendingLabel}{errLabel}
      </Text>
    </View>
  );
}

interface StudentRowProps {
  readonly item: StudentAttendanceItem;
  readonly onStatusChange: (studentId: string, status: AttendanceStatus) => void;
}

function StudentRow({ item, onStatusChange }: StudentRowProps): React.JSX.Element {
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
              accessibilityLabel={`Mark ${item.student.displayName} as ${s}`}
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.statusBtnLabel, isActive && styles.statusBtnLabelActive]}>
                {STATUS_LABELS[s]}
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
        'Incomplete Attendance',
        `${unrecorded.length} student(s) still need a status. Mark everyone before submitting.`,
      );
      return;
    }

    // ── Biometric gate ──────────────────────────────────────────────────────
    setIsBiometricPending(true);
    const verified = await authenticate('Verify your identity to submit attendance');
    setIsBiometricPending(false);

    if (!verified) {
      Alert.alert(
        'Authentication Required',
        'Biometric verification failed. Attendance was not submitted.',
      );
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

      Alert.alert('Submitted', 'Attendance recorded and queued for sync.');
      setAttendanceMap(new Map());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Submission failed';
      Alert.alert('Error', message);
    }
  }, [activeLesson, authState.teacherId, students, attendanceMap, authenticate, enqueue, triggerManualSync]);

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
          errorMessage={syncState.errorMessage}
        />
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No Active Lesson</Text>
          <Text style={styles.emptySubtitle}>
            Select a lesson from your schedule to begin taking attendance.
          </Text>
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
        errorMessage={syncState.errorMessage}
      />

      {/* ── Lesson Header ──────────────────────────────────────────────── */}
      <View style={styles.header}>
        <Text style={styles.headerSubject}>{activeLesson.subjectName}</Text>
        <Text style={styles.headerMeta}>
          {activeLesson.roomName}
          {'  ·  '}
          {new Date(activeLesson.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {' – '}
          {new Date(activeLesson.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
        <Text style={styles.headerProgress}>
          {attendanceMap.size} / {students.length} recorded
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
          accessibilityLabel="Submit attendance — requires biometric verification"
          accessibilityState={{ disabled: !allRecorded || isBusy }}
        >
          {isBiometricPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>
              Submit Attendance  ·  FaceID / TouchID
            </Text>
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
    ...StyleSheet.absoluteFillObject,
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
