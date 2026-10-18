import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { fetchChildren } from '../../services/children';
import { fetchAbsenceReports, mayWithdraw, removeAbsenceReport, reportAbsence } from '../../services/absenceReports';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { schoolDate } from '../../i18n/format';
import { useWindowDimensions } from 'react-native';
import { Column } from '../../layout/Column';
import { READABLE_MAX, TWO_COLUMN_MAX, sideBySide } from '../../layout/responsive';
import type { AbsenceReportRow, AbsenceReportType, ChildRow } from '../../types';

const TYPES: readonly AbsenceReportType[] = ['SICK', 'APPOINTMENT', 'OTHER'];

/** Guardian home: children overview + one-tap absence reporting. */
export function GuardianHomeScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
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
  const wide = sideBySide(useWindowDimensions().width);

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
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />
        }
      >
        <Column max={wide ? TWO_COLUMN_MAX : READABLE_MAX}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{t('guardian.title')}</Text>
            <Text style={styles.headerSubtitle}>{t('guardian.subtitle')}</Text>
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={wide ? styles.split : null}>
          <View style={wide ? styles.half : null}>
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
                placeholderTextColor={colors.textMuted}
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
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.submitText}>{t('guardian.submit')}</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
          </View>

          <View style={wide ? styles.half : null}>
          <View style={[styles.header, wide && styles.headerBeside]}>
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
          </View>
          </View>
          <View style={styles.footerSpace} />
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { padding: 32, alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: c.text, fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  sectionTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  errorText: { color: c.danger, paddingHorizontal: 16, paddingBottom: 8 },
  card: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
  },
  label: { color: c.textMuted, fontSize: 12, marginBottom: 6, marginTop: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: c.primary, borderColor: c.primary },
  chipText: { color: c.textMuted, fontSize: 13 },
  chipTextActive: { color: c.onPrimary, fontWeight: '600' },
  input: {
    backgroundColor: c.background,
    borderColor: c.borderStrong,
    borderWidth: 1,
    borderRadius: 10,
    color: c.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  submit: {
    backgroundColor: c.primary,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 16,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: c.onPrimary, fontWeight: '700' },
  reportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.surface,
    borderColor: c.borderSubtle,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  reportInfo: { flexShrink: 1 },
  reportName: { color: c.text, fontWeight: '600' },
  reportMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  deleteText: { color: c.danger, fontWeight: '600' },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: c.textMuted, paddingHorizontal: 16, paddingBottom: 8 },
  footerSpace: { height: 32 },
  split: { flexDirection: 'row', alignItems: 'flex-start' },
  half: { flexBasis: 0, flexGrow: 1 },
  headerBeside: { paddingTop: 0 },
}));
