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
import { fetchChildren } from '../../services/children';
import { fetchAbsenceReports, mayWithdraw, removeAbsenceReport, reportAbsence } from '../../services/absenceReports';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { schoolDate } from '../../i18n/format';
import type { AbsenceReportRow, AbsenceReportType, ChildRow } from '../../types';

const TYPES: readonly AbsenceReportType[] = ['SICK', 'APPOINTMENT', 'OTHER'];

/** Guardian home: children overview + one-tap absence reporting. */
export function GuardianHomeScreen(): React.JSX.Element {
  const { authState } = useAuth();
  const { t } = useI18n();
  const [children, setChildren] = useState<ChildRow[]>([]);
  const [reports, setReports] = useState<AbsenceReportRow[]>([]);
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  // Null until the guardian types a day: the selected child's today.
  const [date, setDate] = useState<string | null>(null);
  const [type, setType] = useState<AbsenceReportType>('SICK');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!authState.teacherId) return;
    try {
      const [kids, existing] = await Promise.all([
        fetchChildren(),
        fetchAbsenceReports(),
      ]);
      setChildren(kids);
      setReports(existing);
      setSelectedChild((current) => current ?? kids[0]?.id ?? null);
      setError(null);
    } catch {
      setError(t('common.loadError'));
    }
  }, [authState.teacherId, t]);

  useEffect(() => {
    void load().finally(() => setIsLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const childName = useCallback(
    (id: string): string => {
      const child = children.find((entry) => entry.id === id);
      return child ? `${child.firstName} ${child.lastName}` : t('common.noValue');
    },
    [children, t],
  );

  // A child's today is its school's (schoolToday), not the phone's: the
  // gateway holds the report to the school's day, wherever the phone is.
  const todayFor = useCallback(
    (id: string | null): string => schoolDate(children.find((entry) => entry.id === id)?.schoolToday),
    [children],
  );
  const reportDate = date ?? todayFor(selectedChild);

  const submit = useCallback(async () => {
    if (!selectedChild || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      Alert.alert(t('guardian.alertTitle'), t('guardian.pickChildAndDate'));
      return;
    }
    setIsSubmitting(true);
    try {
      // The gateway takes the school from the child and the reporter from the
      // session, and refuses a child who is not this guardian's.
      await reportAbsence({ studentId: selectedChild, date: reportDate, type });
      Alert.alert(t('guardian.alertTitle'), t('guardian.reported'));
      await load();
    } catch (submitError) {
      // The gateway's own refusal stays in the log; the reader gets a sentence.
      console.warn(`[Guardian] Absence report failed: ${submitError instanceof Error ? submitError.name : 'unknown'}`);
      Alert.alert(t('guardian.alertTitle'), t('guardian.reportFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedChild, reportDate, type, load, t]);

  const removeReport = useCallback(
    async (id: string) => {
      try {
        await removeAbsenceReport(id);
      } catch {
        Alert.alert(t('guardian.alertTitle'), t('guardian.reportFailed'));
        return;
      }
      await load();
    },
    [load, t],
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
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{t('guardian.title')}</Text>
          <Text style={styles.headerSubtitle}>{t('guardian.subtitle')}</Text>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {children.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>{t('guardian.noChildrenTitle')}</Text>
            <Text style={styles.emptyBody}>{t('guardian.noChildrenBody')}</Text>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>{t('guardian.child')}</Text>
            <View style={styles.chipRow}>
              {children.map((child) => (
                <TouchableOpacity
                  key={child.id}
                  accessibilityRole="button"
                  onPress={() => setSelectedChild(child.id)}
                  style={[styles.chip, selectedChild === child.id && styles.chipActive]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selectedChild === child.id && styles.chipTextActive,
                    ]}
                  >
                    {`${child.firstName} ${child.lastName}`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.label}>{t('guardian.dateLabel')}</Text>
            <TextInput
              style={styles.input}
              value={reportDate}
              onChangeText={setDate}
              placeholder={t('guardian.datePlaceholder')}
              placeholderTextColor="#64748b"
              autoCapitalize="none"
            />

            <Text style={styles.label}>{t('guardian.reasonLabel')}</Text>
            <View style={styles.chipRow}>
              {TYPES.map((value) => (
                <TouchableOpacity
                  key={value}
                  accessibilityRole="button"
                  onPress={() => setType(value)}
                  style={[styles.chip, type === value && styles.chipActive]}
                >
                  <Text style={[styles.chipText, type === value && styles.chipTextActive]}>
                    {t(`guardian.types.${value}`)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              accessibilityRole="button"
              style={[styles.submit, isSubmitting && styles.submitDisabled]}
              onPress={() => void submit()}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.submitText}>{t('guardian.submit')}</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.header}>
          <Text style={styles.sectionTitle}>{t('guardian.reportsTitle')}</Text>
        </View>
        {reports.length === 0 ? (
          <Text style={styles.emptyBody}>{t('guardian.reportsEmpty')}</Text>
        ) : (
          reports.map((report) => (
            <View key={report.id} style={styles.reportRow}>
              <View style={styles.reportInfo}>
                <Text style={styles.reportName}>{childName(report.studentId)}</Text>
                <Text style={styles.reportMeta}>
                  {[
                    report.date.slice(0, 10),
                    t(`guardian.types.${report.type}`),
                    report.startTime
                      ? `${report.startTime.slice(0, 5)}–${report.endTime?.slice(0, 5) ?? ''}`
                      : t('common.fullDay'),
                  ].join(' · ')}
                </Text>
              </View>
              {/* Only the reporter takes a report back, and only before its day
                  has passed in the school's day: the gateway says which
                  (removable) and refuses the rest, so nobody is offered a
                  button that can only fail, wherever the phone is. */}
              {mayWithdraw(report, authState.teacherId, todayFor(report.studentId)) ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('guardian.deleteA11y')}
                  onPress={() => void removeReport(report.id)}
                >
                  <Text style={styles.deleteText}>{t('common.delete')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))
        )}
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
  sectionTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  errorText: { color: '#f87171', paddingHorizontal: 16, paddingBottom: 8 },
  card: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2d2d4a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
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
  submit: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 16,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#ffffff', fontWeight: '700' },
  reportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a2e',
    borderColor: '#1e1e3a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  reportInfo: { flexShrink: 1 },
  reportName: { color: '#e2e8f0', fontWeight: '600' },
  reportMeta: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  deleteText: { color: '#f87171', fontWeight: '600' },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  emptyBody: { color: '#94a3b8', paddingHorizontal: 16, paddingBottom: 8 },
  footerSpace: { height: 32 },
});
