import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
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
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { fetchChildren } from '../../services/children';
import {
  DEFAULT_LEAVE_POLICY,
  answerLeaveConsent,
  asksForContact,
  consentErrorText,
  deciderOf,
  fetchLeavePolicy,
  fetchLeaveRequests,
  filingErrorText,
  omitKey,
  requestLeave,
  withConsentAnswer,
  type LeaveRequestFiled,
} from '../../services/leaveRequests';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { schoolDate } from '../../i18n/format';
import { Column } from '../../layout/Column';
import { READABLE_MAX, TWO_COLUMN_MAX, sideBySide } from '../../layout/responsive';
import type { ChildRow, LeaveContactMode, LeavePolicy, LeaveRequestRow, LeaveRequestStatus } from '../../types';

/** One meaning per colour, as the web's LEAVE_STATUS_VARIANT: an undecided request needs action. */
const STATUS_TONE: Record<LeaveRequestStatus, Tone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  // Ended by a guardian's "no", not decided by the school: neither a yes nor the school's no.
  GUARDIAN_DECLINED: 'neutral',
};

/** The policy shapes the form and no more: a read that fails leaves the one in hand (the all-off one at first). */
async function readPolicy(): Promise<LeavePolicy | null> {
  try {
    return (await fetchLeavePolicy()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Leave requests (ledighetsansökan): submit + follow decisions, and, where the
 * school asks every guardian to consent (Ledighetspolicy), answer.
 *
 * EVERYTHING THE POLICY ADDS IS OFF UNTIL THE POLICY OR THE ANSWER SAYS SO.
 * The form shows the temporary contact's three fields only when the school's
 * policy has them (and marks them required when it requires them), explains
 * the school's minimum of days ahead when there is one, and says that all
 * guardians are asked when they are. A list row shows consent, a flag or a
 * contact only when the row carries it. A gateway from before the policy
 * sends none of it, and the screen is then the screen it was.
 *
 * WHAT IT NEVER SAYS: who answered what. The applicant sees that the request
 * waits for the guardians' consent, or that it ended because "a guardian" did
 * not consent; a guardian sees their own answer and never the other's.
 *
 * A CONSENT CANNOT BE CHANGED. A yes is sent at once, a no after a question
 * that says so, and neither is ever queued: a phone with no network is told
 * so and the buttons stay. Read again whenever the tab is seen, as a push
 * about a request opens it (appGate leaveConsentTarget).
 */
export function LeaveRequestsScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { authState } = useAuth();
  const { t } = useI18n();
  const [children, setChildren] = useState<ChildRow[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequestRow[]>([]);
  const [policy, setPolicy] = useState<LeavePolicy>(DEFAULT_LEAVE_POLICY);
  const [selectedChild, setSelectedChild] = useState<string | null>(null);
  // Null until the guardian types a day: the selected child's today.
  const [startInput, setStartDate] = useState<string | null>(null);
  const [endInput, setEndDate] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactRelation, setContactRelation] = useState('');
  // The gateway asked for a contact that the policy read did not promise (an older read, or one that failed): show the fields.
  const [contactAsked, setContactAsked] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Per request: the answer that is in the air (true: consent), and what became of a tap that was not recorded.
  const [answering, setAnswering] = useState<Readonly<Record<string, boolean>>>({});
  const [answerNotes, setAnswerNotes] = useState<Readonly<Record<string, string>>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const wide = sideBySide(useWindowDimensions().width);
  /** The newest read: an older answer arriving late never replaces it. */
  const newest = useRef(0);
  const alive = useRef(true);
  /** One answer per request in the air: a second tap before the render is dropped. */
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!authState.teacherId) return;
    const mine = ++newest.current;
    const [kids, rows, read] = await Promise.all([fetchChildren(), fetchLeaveRequests(), readPolicy()]);
    if (!alive.current || mine !== newest.current) return;
    setChildren(kids);
    setLeaves(rows);
    if (read) setPolicy(read);
    setSelectedChild((current) => current ?? kids[0]?.id ?? null);
  }, [authState.teacherId]);

  // A tab stays mounted once opened, and a push about a request opens it: read again whenever it is seen.
  useFocusEffect(
    useCallback(() => {
      void load()
        .catch(() => undefined)
        .finally(() => {
          if (alive.current) setIsLoading(false);
        });
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load().catch(() => undefined);
    if (alive.current) setIsRefreshing(false);
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

  const contactMode: LeaveContactMode = policy.contact !== 'OFF' ? policy.contact : contactAsked ? 'REQUIRED' : 'OFF';

  /** iOS has no live regions: it is told. Android reads the region the sentence appears in, and is not told twice. */
  const announce = useCallback((text: string): void => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, []);

  const submit = useCallback(async () => {
    if (!selectedChild || reason.trim().length < 3) {
      Alert.alert(t('leave.alertTitle'), t('leave.pickChildAndReason'));
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      // No status: a new request is undecided, and the school decides it. The
      // gateway takes the school from the child and the requester from the
      // session, and the pupil's mentor is told when the school's delegation
      // gives it to them to decide. The contact goes only when the form
      // showed its fields; the gateway judges whether it is enough.
      let filed: LeaveRequestFiled;
      try {
        filed = await requestLeave({
          studentId: selectedChild,
          startDate,
          endDate,
          reason,
          ...(contactMode !== 'OFF' ? { contactName, contactPhone, contactRelation } : {}),
        });
      } catch (submitFailure) {
        console.warn(`[Leave] Request failed: ${submitFailure instanceof Error ? submitFailure.name : 'unknown'}`);
        if (asksForContact(submitFailure)) setContactAsked(true);
        const text = filingErrorText(submitFailure, t, policy.minDaysAhead);
        setSubmitError(text);
        announce(text);
        return;
      }
      setReason('');
      setContactName('');
      setContactPhone('');
      setContactRelation('');
      setContactAsked(false);
      // What the answer says about this request, after the usual sentence: that every guardian is asked, that it was flagged.
      const sentences = [t('leave.submitted')];
      if (filed?.consentRequired) sentences.push(t('leave.submittedConsent'));
      if (filed?.shortNotice) sentences.push(t('leave.submittedFlagged'));
      Alert.alert(t('leave.alertTitle'), sentences.join(' '));
      await load().catch(() => undefined);
    } finally {
      if (alive.current) setIsSubmitting(false);
    }
  }, [selectedChild, startDate, endDate, reason, contactMode, contactName, contactPhone, contactRelation, policy.minDaysAhead, load, announce, t]);

  const send = useCallback(
    async (leave: LeaveRequestRow, consent: boolean): Promise<void> => {
      if (inFlight.current.has(leave.id)) return;
      inFlight.current.add(leave.id);
      setAnswering((current) => ({ ...current, [leave.id]: consent }));
      setAnswerNotes((current) => omitKey(current, leave.id));
      try {
        const done = await answerLeaveConsent(leave.id, consent);
        const answer = done?.answer ?? (consent ? 'GIVEN' : 'REFUSED');
        if (alive.current) {
          // Remembered over the list at once; the read after it is the gateway's own word.
          setLeaves((rows) => rows.map((row) => (row.id === leave.id ? withConsentAnswer(row, { answer, state: done?.state }) : row)));
        }
        announce(t(answer === 'REFUSED' ? 'leave.consent.announceRefused' : 'leave.consent.announceGiven'));
        void load().catch(() => undefined);
      } catch (answerFailure) {
        console.warn(`[Leave] Consent failed: ${answerFailure instanceof Error ? answerFailure.name : 'unknown'}`);
        const failure = consentErrorText(answerFailure, t);
        if (alive.current) setAnswerNotes((current) => ({ ...current, [leave.id]: failure.text }));
        announce(failure.text);
        // The request has moved on without the guardian: the list says how.
        if (failure.moved) void load().catch(() => undefined);
      } finally {
        inFlight.current.delete(leave.id);
        if (alive.current) setAnswering((current) => omitKey(current, leave.id));
      }
    },
    [announce, load, t],
  );

  const onAnswer = useCallback(
    (leave: LeaveRequestRow, consent: boolean): void => {
      if (consent) {
        void send(leave, true);
        return;
      }
      // A no ends the request and cannot be taken back: asked once, with the words.
      Alert.alert(t('leave.consent.confirmTitle'), t('leave.consent.confirmBody', { name: childName(leave.studentId) }), [
        { text: t('leave.consent.confirmCancel'), style: 'cancel' },
        { text: t('leave.consent.confirmDecline'), style: 'destructive', onPress: () => void send(leave, false) },
      ]);
    },
    [childName, send, t],
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

  const fieldLabel = (key: 'leave.contactName' | 'leave.contactPhone' | 'leave.contactRelation'): string =>
    t(contactMode === 'REQUIRED' ? 'leave.fieldRequired' : 'leave.fieldOptional', { label: t(key) });
  const nameLabel = fieldLabel('leave.contactName');
  const phoneLabel = fieldLabel('leave.contactPhone');
  const relationLabel = fieldLabel('leave.contactRelation');

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
            {/* The school's minimum, in words, where the days are chosen. */}
            {policy.minDaysAhead !== null ? (
              <Text style={styles.hint}>
                {t(policy.shortNotice === 'FLAG' ? 'leave.minDaysFlag' : 'leave.minDaysRefuse', { count: policy.minDaysAhead })}
              </Text>
            ) : null}
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
            {contactMode !== 'OFF' ? (
              <View>
                <Text style={styles.sectionTitle} accessibilityRole="header">
                  {t('leave.contactTitle')}
                </Text>
                <Text style={styles.hint}>
                  {t(contactMode === 'REQUIRED' ? 'leave.contactHintRequired' : 'leave.contactHintOptional')}
                </Text>
                <Text style={styles.label}>{nameLabel}</Text>
                <TextInput
                  style={styles.input}
                  accessibilityLabel={nameLabel}
                  value={contactName}
                  onChangeText={setContactName}
                  maxLength={100}
                  autoCapitalize="words"
                  // A third party's details: never the phone's own autofill of the guardian's.
                  autoComplete="off"
                  importantForAutofill="no"
                  textContentType="none"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={styles.label}>{phoneLabel}</Text>
                <TextInput
                  style={styles.input}
                  accessibilityLabel={phoneLabel}
                  value={contactPhone}
                  onChangeText={setContactPhone}
                  maxLength={30}
                  keyboardType="phone-pad"
                  autoComplete="off"
                  importantForAutofill="no"
                  textContentType="none"
                  placeholderTextColor={colors.textMuted}
                />
                <Text style={styles.label}>{relationLabel}</Text>
                <TextInput
                  style={styles.input}
                  accessibilityLabel={relationLabel}
                  value={contactRelation}
                  onChangeText={setContactRelation}
                  maxLength={60}
                  autoComplete="off"
                  importantForAutofill="no"
                  textContentType="none"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
            ) : null}
            {policy.requireAllGuardians ? <Text style={styles.hint}>{t('leave.allGuardiansHint')}</Text> : null}
            {/* Always mounted, so a screen reader that follows live regions says what the form refused. */}
            <View accessibilityLiveRegion="polite">
              {submitError !== null ? <Note tone="danger" text={submitError} /> : null}
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
                <Text style={styles.submitText}>{t('leave.submit')}</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={wide ? styles.half : null}>
          {leaves.map((leave) => (
            <LeaveRow
              key={leave.id}
              leave={leave}
              name={childName(leave.studentId)}
              answering={answering[leave.id]}
              note={answerNotes[leave.id] ?? null}
              onAnswer={onAnswer}
            />
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

/** A sentence in a tone's tint and ink, with its words doing the work as the colour does. */
function Note({ tone, text }: { readonly tone: Tone; readonly text: string }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={[styles.note, { backgroundColor: colors.toneTint[tone], borderColor: colors[tone] }]} accessibilityRole="alert">
      <Text style={[styles.noteText, { color: colors[tone] }]}>{text}</Text>
    </View>
  );
}

/**
 * One request in the list. The status, the decision and the note are the
 * list's old rows; the lines below them appear only for what the row carries:
 * the contact the family wrote, a flag for a late request, and the consent
 * (the guardian's own question, or where the request stands).
 */
function LeaveRow({
  leave,
  name,
  answering,
  note,
  onAnswer,
}: {
  readonly leave: LeaveRequestRow;
  readonly name: string;
  /** The answer in the air (true: consent), undefined when none is. */
  readonly answering: boolean | undefined;
  readonly note: string | null;
  readonly onAnswer: (leave: LeaveRequestRow, consent: boolean) => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const consent = leave.consent;
  const from = leave.startDate.slice(0, 10);
  const to = leave.endDate.slice(0, 10);
  const busy = answering !== undefined;
  // The guardian's own question: only while the request still waits, whatever else the row says.
  const asked = consent?.mine === 'WAITING' && leave.status === 'PENDING';
  const ended = leave.status === 'GUARDIAN_DECLINED' || consent?.state === 'REFUSED';
  // Where the request stands, for everyone but the guardian who is being asked or whose custody ended, and only while it waits:
  // a request the school has decided is no longer waiting for anyone (the gateway still answers WAITING for a rejected one whose
  // guardians never answered), as on the web.
  const standing =
    consent?.required !== true || leave.status !== 'PENDING' || asked || consent.mine === 'ENDED' || ended
      ? null
      : consent.state === 'WAITING'
        ? 'leave.consent.waiting'
        : consent.state === 'GIVEN'
          ? 'leave.consent.allGiven'
          : null;

  return (
    <View style={styles.leaveRow}>
      <View style={styles.leaveHeader}>
        <Text style={styles.leaveName}>{name}</Text>
        <Text style={[styles.leaveStatus, { color: colors[STATUS_TONE[leave.status] ?? 'neutral'] }]}>
          {t(`leave.status.${leave.status}`)}
        </Text>
      </View>
      <Text style={styles.leaveMeta}>{`${from} – ${to}`}</Text>
      <Text style={styles.leaveReason}>{leave.reason}</Text>
      {deciderOf(leave) ? (
        <Text style={styles.leaveNote}>
          {t(deciderOf(leave) === 'MENTOR' ? 'leave.decidedByMentor' : 'leave.decidedByRektor')}
        </Text>
      ) : null}
      {leave.decisionNote ? (
        <Text style={styles.leaveNote}>{t('leave.note', { note: leave.decisionNote })}</Text>
      ) : null}
      {leave.contact ? (
        <Text style={styles.leaveNote}>
          {t('leave.contactRow', { name: leave.contact.name, phone: leave.contact.phone, relation: leave.contact.relation })}
        </Text>
      ) : null}
      {leave.shortNotice === true ? <Text style={styles.leaveNote}>{t('leave.flagged')}</Text> : null}
      {ended ? <Text style={styles.leaveNote}>{t('leave.guardianDeclined')}</Text> : null}
      {consent?.mine === 'GIVEN' ? <Text style={styles.leaveNote}>{t('leave.consent.mineGiven')}</Text> : null}
      {consent?.mine === 'REFUSED' ? <Text style={styles.leaveNote}>{t('leave.consent.mineRefused')}</Text> : null}
      {consent?.mine === 'ENDED' ? <Text style={styles.leaveNote}>{t('leave.consent.mineEnded')}</Text> : null}
      {standing !== null ? <Text style={styles.leaveNote}>{t(standing)}</Text> : null}
      {asked ? (
        <View style={styles.consentBox}>
          <Text style={styles.consentText}>{t('leave.consent.ask')}</Text>
          <View style={styles.consentButtons}>
            <TouchableOpacity
              style={[styles.consentButton, styles.consentAgree, busy && styles.disabled]}
              onPress={() => onAnswer(leave, true)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t('leave.consent.agreeA11y', { name, from, to })}
              accessibilityState={{ disabled: busy, busy: answering === true }}
            >
              {answering === true ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.consentAgreeText}>{t('leave.consent.agree')}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.consentButton, styles.consentDecline, busy && styles.disabled]}
              onPress={() => onAnswer(leave, false)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t('leave.consent.declineA11y', { name, from, to })}
              accessibilityState={{ disabled: busy, busy: answering === false }}
            >
              {answering === false ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Text style={styles.consentDeclineText}>{t('leave.consent.decline')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {/* Always mounted, so a screen reader that follows live regions says what became of the tap. */}
      <View accessibilityLiveRegion="polite">{note !== null ? <Note tone="danger" text={note} /> : null}</View>
    </View>
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
  hint: { color: c.textMuted, fontSize: 12, lineHeight: 17, marginTop: 8 },
  sectionTitle: { color: c.text, fontSize: 14, fontWeight: '700', marginTop: 18 },
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
  note: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginTop: 12 },
  noteText: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
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
  consentBox: { borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 10 },
  consentText: { color: c.text, fontSize: 13, lineHeight: 19 },
  consentButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  consentButton: {
    flexGrow: 1,
    flexBasis: 120,
    minHeight: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  consentAgree: { backgroundColor: c.primary },
  consentAgreeText: { color: c.onPrimary, fontWeight: '700', textAlign: 'center' },
  consentDecline: { backgroundColor: c.surface, borderColor: c.primary, borderWidth: 1 },
  consentDeclineText: { color: c.primary, fontWeight: '700', textAlign: 'center' },
  disabled: { opacity: DISABLED_OPACITY },
  footerSpace: { height: 32 },
  split: { flexDirection: 'row', alignItems: 'flex-start' },
  half: { flexBasis: 0, flexGrow: 1 },
}));
