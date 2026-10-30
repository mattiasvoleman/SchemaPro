import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
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
import type { Tone } from '../../theme/tokens';
import { fetchChildren } from '../../services/children';
import { deciderOf, fetchLeaveRequests, requestLeave } from '../../services/leaveRequests';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { schoolDate } from '../../i18n/format';
import { useWindowDimensions } from 'react-native';
import { Column } from '../../layout/Column';
import { READABLE_MAX, TWO_COLUMN_MAX, sideBySide } from '../../layout/responsive';
import type { ChildRow, LeaveRequestRow, LeaveRequestStatus } from '../../types';

/** One meaning per colour, as the web's LEAVE_STATUS_VARIANT: an undecided request needs action. */
const STATUS_TONE: Record<LeaveRequestStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
};

/** Leave requests (ledighetsansökan): submit + follow decisions. */
export function LeaveRequestsScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { authState } = useAuth();
  const { t } = useI18n();
  const [children, setChildren] = useState<ChildRow[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequestRow[]>([]);
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  // Null until the guardian types a day: the selected child's today.
  const [startInput, setStartDate] = useState<string | null>(null);
  const [endInput, setEndDate] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const wide = sideBySide(useWindowDimensions().width);

  const load = useCallback(async () => {
    if (!authState.teacherId) return;
    const [kids, rows] = await Promise.all([
      fetchChildren(),
      fetchLeaveRequests(),
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

  // The child's today is its school's (schoolToday), not the phone's.
  const today = schoolDate(children.find((entry) => entry.id === selectedChild)?.schoolToday);
  const startDate = startInput ?? today;
  const endDate = endInput ?? today;

  const submit = useCallback(async () => {
    if (!selectedChild || reason.trim().length < 3) {
      Alert.alert(t('leave.alertTitle'), t('leave.pickChildAndReason'));
      return;
    }
    setIsSubmitting(true);
    try {
      // No status: a new request is undecided, and the school decides it. The
      // gateway takes the school from the child and the requester from the
      // session, and the pupil's mentor is told when the school's delegation
      // gives it to them to decide.
      await requestLeave({ studentId: selectedChild, startDate, endDate, reason });
      setReason('');
      Alert.alert(t('leave.alertTitle'), t('leave.submitted'));
      await load();
    } catch (submitError) {
      console.warn(`[Leave] Request failed: ${submitError instanceof Error ? submitError.name : 'unknown'}`);
      Alert.alert(t('leave.alertTitle'), t('leave.submitFailed'));
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedChild, startDate, endDate, reason, load, t]);

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
      {/* On iOS the keyboard insets the scroll and keeps the field typed in
          above it, also on an iPad on its side, where the form is shorter
          than the screen and could not otherwise be scrolled. Android ignores
          that prop, and its edge-to-edge window does not shrink for the
          keyboard, so there the view around the scroll gives up the
          keyboard's height, as login does, and the scroll brings the field
          into what is left. A chip or the button takes its tap while the
          keyboard is up. */}
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'android' ? 'height' : undefined}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />
        }
      >
        <Column max={wide ? TWO_COLUMN_MAX : READABLE_MAX}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{t('leave.title')}</Text>
            <Text style={styles.headerSubtitle}>{t('leave.subtitle')}</Text>
          </View>

          <View style={wide ? styles.split : null}>
          <View style={[styles.card, wide && styles.half]}>
            <Text style={styles.label}>{t('leave.child')}</Text>
            <View style={styles.chipRow}>
              {children.map((child) => (
                <TouchableOpacity
                  key={child.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedChild === child.id }}
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
              accessibilityLabel={t('leave.from')}
              value={startDate}
              onChangeText={setStartDate}
              autoCapitalize="none"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={styles.label}>{t('leave.to')}</Text>
            <TextInput
              style={styles.input}
              accessibilityLabel={t('leave.to')}
              value={endDate}
              onChangeText={setEndDate}
              autoCapitalize="none"
              placeholderTextColor={colors.textMuted}
            />
            <Text style={styles.label}>{t('leave.reason')}</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              accessibilityLabel={t('leave.reason')}
              value={reason}
              onChangeText={setReason}
              multiline
              placeholder={t('leave.reasonPlaceholder')}
              placeholderTextColor={colors.textMuted}
            />
            <TouchableOpacity
              accessibilityRole="button"
              style={[styles.submit, isSubmitting && styles.submitDisabled]}
              onPress={() => void submit()}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.submitText}>{t('leave.submit')}</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={wide ? styles.half : null}>
          {leaves.map((leave) => (
            <View key={leave.id} style={styles.leaveRow}>
              <View style={styles.leaveHeader}>
                <Text style={styles.leaveName}>{childName(leave.studentId)}</Text>
                <Text style={[styles.leaveStatus, { color: colors[STATUS_TONE[leave.status]] }]}>
                  {t(`leave.status.${leave.status}`)}
                </Text>
              </View>
              <Text style={styles.leaveMeta}>
                {`${leave.startDate.slice(0, 10)} – ${leave.endDate.slice(0, 10)}`}
              </Text>
              <Text style={styles.leaveReason}>{leave.reason}</Text>
              {deciderOf(leave) ? (
                <Text style={styles.leaveNote}>
                  {t(deciderOf(leave) === 'MENTOR' ? 'leave.decidedByMentor' : 'leave.decidedByRektor')}
                </Text>
              ) : null}
              {leave.decisionNote ? (
                <Text style={styles.leaveNote}>{t('leave.note', { note: leave.decisionNote })}</Text>
              ) : null}
            </View>
          ))}
          </View>
          </View>
          <View style={styles.footerSpace} />
        </Column>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  keyboard: { flex: 1 },
  center: { padding: 32, alignItems: 'center' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: c.text, fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  card: {
    backgroundColor: c.surface,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 16,
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
  multiline: { minHeight: 70, textAlignVertical: 'top' },
  submit: {
    backgroundColor: c.primary,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 16,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: c.onPrimary, fontWeight: '700' },
  leaveRow: {
    backgroundColor: c.surface,
    borderColor: c.borderSubtle,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  leaveHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  leaveName: { color: c.text, fontWeight: '600' },
  leaveStatus: { fontWeight: '700', fontSize: 12 },
  leaveMeta: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  leaveReason: { color: c.text, marginTop: 4 },
  leaveNote: { color: c.textMuted, fontSize: 12, marginTop: 4 },
  footerSpace: { height: 32 },
  split: { flexDirection: 'row', alignItems: 'flex-start' },
  half: { flexBasis: 0, flexGrow: 1 },
}));
