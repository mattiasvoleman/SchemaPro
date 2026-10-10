import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  SafeAreaView,
} from 'react-native';
import { getSupabase } from '../../services/supabase';
import { fetchChildren } from '../../services/children';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import type { ChildRow, LeaveRequestRow, LeaveRequestStatus } from '../../types';

const STATUS_COLORS: Record<LeaveRequestStatus, string> = {
  PENDING: '#94a3b8',
  APPROVED: '#34d399',
  REJECTED: '#f87171',
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchLeaves(): Promise<LeaveRequestRow[]> {
  const { data, error } = await getSupabase()
    .from('LeaveRequests')
    .select('id, studentId, startDate, endDate, reason, status, decisionNote, createdAt')
    .order('createdAt', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as LeaveRequestRow[];
}

/** Leave requests (ledighetsansökan): submit + follow decisions. */
export function LeaveRequestsScreen(): React.JSX.Element {
  const { authState } = useAuth();
  const { t } = useI18n();
  const [children, setChildren] = useState<ChildRow[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequestRow[]>([]);
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!authState.teacherId) return;
    const [kids, rows] = await Promise.all([
      fetchChildren(authState.teacherId),
      fetchLeaves(),
    ]);
    setChildren(kids);
    setLeaves(rows);
    setSelectedChild((current) => current ?? kids[0]?.id ?? null);
  }, [authState.teacherId]);

  useEffect(() => {
    void load()
      .catch(() => undefined)
      .finally(() => setIsLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load().catch(() => undefined);
    setIsRefreshing(false);
  }, [load]);

  const childName = useCallback(
    (id: string): string => {
      const child = children.find((entry) => entry.id === id);
      return child ? `${child.firstName} ${child.lastName}` : t('common.noValue');
    },
    [children, t],
  );

  const submit = useCallback(async () => {
    if (!selectedChild || reason.trim().length < 3) {
      Alert.alert(t('leave.alertTitle'), t('leave.pickChildAndReason'));
      return;
    }
    setIsSubmitting(true);
    try {
      const { data: profile } = await getSupabase()
        .from('Users')
        .select('schoolId')
        .eq('id', selectedChild)
        .single();
      const { error } = await getSupabase().from('LeaveRequests').insert({
        schoolId: (profile as { schoolId: string }).schoolId,
        studentId: selectedChild,
        requestedById: authState.teacherId,
        startDate,
        endDate,
        reason: reason.trim(),
      });
      if (error) throw new Error(error.message);
      setReason('');
      Alert.alert(t('leave.alertTitle'), t('leave.submitted'));
      await load();
    } catch (submitError) {
      console.warn(`[Leave] Request failed: ${submitError instanceof Error ? submitError.name : 'unknown'}`);
      Alert.alert(t('leave.alertTitle'), t('leave.submitFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedChild, startDate, endDate, reason, authState.teacherId, load, t]);

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
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{t('leave.title')}</Text>
          <Text style={styles.headerSubtitle}>{t('leave.subtitle')}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>{t('leave.child')}</Text>
          <View style={styles.chipRow}>
            {children.map((child) => (
              <TouchableOpacity
                key={child.id}
                accessibilityRole="button"
                onPress={() => setSelectedChild(child.id)}
                style={[styles.chip, selectedChild === child.id && styles.chipActive]}
              >
                <Text
                  style={[styles.chipText, selectedChild === child.id && styles.chipTextActive]}
                >
                  {`${child.firstName} ${child.lastName}`}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.label}>{t('leave.from')}</Text>
          <TextInput
            style={styles.input}
            value={startDate}
            onChangeText={setStartDate}
            autoCapitalize="none"
            placeholderTextColor="#64748b"
          />
          <Text style={styles.label}>{t('leave.to')}</Text>
          <TextInput
            style={styles.input}
            value={endDate}
            onChangeText={setEndDate}
            autoCapitalize="none"
            placeholderTextColor="#64748b"
          />
          <Text style={styles.label}>{t('leave.reason')}</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={reason}
            onChangeText={setReason}
            multiline
            placeholder={t('leave.reasonPlaceholder')}
            placeholderTextColor="#64748b"
          />
          <TouchableOpacity
            accessibilityRole="button"
            style={[styles.submit, isSubmitting && styles.submitDisabled]}
            onPress={() => void submit()}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.submitText}>{t('leave.submit')}</Text>
            )}
          </TouchableOpacity>
        </View>

        {leaves.map((leave) => (
          <View key={leave.id} style={styles.leaveRow}>
            <View style={styles.leaveHeader}>
              <Text style={styles.leaveName}>{childName(leave.studentId)}</Text>
              <Text style={[styles.leaveStatus, { color: STATUS_COLORS[leave.status] }]}>
                {t(`leave.status.${leave.status}`)}
              </Text>
            </View>
            <Text style={styles.leaveMeta}>
              {`${leave.startDate.slice(0, 10)} – ${leave.endDate.slice(0, 10)}`}
            </Text>
            <Text style={styles.leaveReason}>{leave.reason}</Text>
            {leave.decisionNote ? (
              <Text style={styles.leaveNote}>{t('leave.note', { note: leave.decisionNote })}</Text>
            ) : null}
          </View>
        ))}
        <View style={styles.footerSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  center: { padding: 32, alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: '#e2e8f0', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  card: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2d2d4a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 16,
  },
  label: { color: '#94a3b8', fontSize: 12, marginBottom: 6, marginTop: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderColor: '#2d2d4a',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: '#6366f1', borderColor: '#6366f1' },
  chipText: { color: '#94a3b8', fontSize: 13 },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  input: {
    backgroundColor: '#0f0f1a',
    borderColor: '#2d2d4a',
    borderWidth: 1,
    borderRadius: 10,
    color: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 70, textAlignVertical: 'top' },
  submit: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 16,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#ffffff', fontWeight: '700' },
  leaveRow: {
    backgroundColor: '#1a1a2e',
    borderColor: '#1e1e3a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  leaveHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  leaveName: { color: '#e2e8f0', fontWeight: '600' },
  leaveStatus: { fontWeight: '700', fontSize: 12 },
  leaveMeta: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  leaveReason: { color: '#cbd5e1', marginTop: 4 },
  leaveNote: { color: '#94a3b8', fontSize: 12, marginTop: 4 },
  footerSpace: { height: 32 },
});
