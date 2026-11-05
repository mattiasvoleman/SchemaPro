import React, { useMemo } from 'react';
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
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useCoverRequests, type Pending } from '../../hooks/useCoverRequests';
import { formatDayHeading, formatTime } from '../../i18n/format';
import type { Locale, MessageKey } from '../../i18n';
import { useColumnLayout } from '../../layout/responsive';
import {
  answerable,
  lessonsByDay,
  noteOf,
  splitRequests,
  untilText,
  type AnswerOutcome,
  type ConfirmOutcome,
  type MyCoverPass,
  type MyCoverRequest,
  type MyRequestState,
} from '../../services/coverRequests';

// ─────────────────────────────────────────────────────────────────────────────
// Vikarieförfrågningar (D4), the teacher's side of "can you cover these
// lessons?". The school asks chosen colleagues; the FIRST yes gets all the
// lessons, so a yes is sent live (services/coverRequests.ts: nothing is
// queued, an offline phone is told so). A question names the lessons and the
// time to answer by, never who is away or why: the gateway does not send it
// and this screen does not look it up.
//
// Three groups: the questions waiting for an answer (the card turns into its
// own confirmation when answered), the passes a cover decision has given the
// teacher (one tap confirms), and the questions that ended, in words.
// ─────────────────────────────────────────────────────────────────────────────

type Row =
  | { readonly kind: 'OPEN'; readonly request: MyCoverRequest }
  | { readonly kind: 'NONE_OPEN' }
  | { readonly kind: 'PASS'; readonly pass: MyCoverPass }
  | { readonly kind: 'PAST'; readonly request: MyCoverRequest };

interface Group {
  readonly key: 'open' | 'passes' | 'past';
  /** The catalogue key of the group's heading. */
  readonly heading: MessageKey;
  readonly data: readonly Row[];
}

/** One meaning per colour: yours is green, an ended question is plain ink. */
const STATE_TONE: Record<MyRequestState, Tone> = {
  OPEN: 'warning',
  ACCEPTED_BY_ME: 'success',
  DECLINED_BY_ME: 'neutral',
  TAKEN: 'neutral',
  WITHDRAWN: 'neutral',
  EXPIRED: 'neutral',
  CLOSED: 'neutral',
};

const STATE_LABEL: Record<MyRequestState, MessageKey> = {
  OPEN: 'coverRequests.state.OPEN',
  ACCEPTED_BY_ME: 'coverRequests.state.ACCEPTED_BY_ME',
  DECLINED_BY_ME: 'coverRequests.state.DECLINED_BY_ME',
  TAKEN: 'coverRequests.state.TAKEN',
  WITHDRAWN: 'coverRequests.state.WITHDRAWN',
  EXPIRED: 'coverRequests.state.EXPIRED',
  CLOSED: 'coverRequests.state.CLOSED',
};

export function CoverRequestsScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const { authState } = useAuth();
  const { gutter } = useColumnLayout();
  // The administrator shares this shell (and its route) but is not asked: the
  // gateway answers a teacher only, so nothing is read for anyone else.
  const teacher = authState.role === 'TEACHER';
  const state = useCoverRequests(teacher);
  const { cover, answers, confirmations, pending } = state;

  const groups = useMemo((): Group[] => {
    const { open, past } = splitRequests(cover.requests, new Set(Object.keys(answers)));
    const openRows: Row[] = open.map((request) => ({ kind: 'OPEN', request }));
    if (openRows.length === 0 && (cover.passes.length > 0 || past.length > 0)) openRows.push({ kind: 'NONE_OPEN' });
    const result: Group[] = [];
    if (openRows.length > 0) result.push({ key: 'open', heading: 'coverRequests.sectionOpen', data: openRows });
    if (cover.passes.length > 0) {
      result.push({ key: 'passes', heading: 'coverRequests.sectionPasses', data: cover.passes.map((pass) => ({ kind: 'PASS', pass })) });
    }
    if (past.length > 0) {
      result.push({ key: 'past', heading: 'coverRequests.sectionPast', data: past.map((request) => ({ kind: 'PAST', request })) });
    }
    return result;
  }, [cover, answers]);

  if (!teacher) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>{t('coverRequests.teachersOnly')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state.isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const waiting = cover.requests.filter((request) => request.state === 'OPEN').length;
  const failedFirst = state.problem !== null && !state.hasLoaded;

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <Text style={styles.headerTitle}>{t('coverRequests.title')}</Text>
        <Text style={styles.headerSubtitle}>
          {waiting > 0 ? t('coverRequests.subtitleOpen', { count: waiting }) : t('coverRequests.subtitleNone')}
        </Text>
      </View>

      {state.problem !== null && state.hasLoaded ? (
        <Text
          style={[styles.problem, { paddingHorizontal: gutter, color: state.problem === 'OFFLINE' ? colors.warning : colors.danger }]}
          accessibilityRole="alert"
        >
          {state.problem === 'OFFLINE' ? t('coverRequests.problemOffline') : t('coverRequests.problemFailed')}
        </Text>
      ) : null}

      <SectionList<Row, Group>
        sections={groups}
        keyExtractor={(row) => {
          if (row.kind === 'NONE_OPEN') return 'none-open';
          if (row.kind === 'PASS') return `pass:${row.pass.lessonId}`;
          return `${row.kind === 'OPEN' ? 'open' : 'past'}:${row.request.id}`;
        }}
        refreshControl={
          <RefreshControl
            refreshing={state.isRefreshing}
            onRefresh={state.refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{t(section.heading)}</Text>}
        renderItem={({ item }) => {
          switch (item.kind) {
            case 'NONE_OPEN':
              return <Text style={styles.noneOpen}>{t('coverRequests.noneOpen')}</Text>;
            case 'OPEN':
              return (
                <OpenCard
                  request={item.request}
                  outcome={answers[item.request.id]}
                  pending={pending}
                  onAnswer={(choice) => void state.answer(item.request.id, choice)}
                />
              );
            case 'PASS':
              return (
                <PassCard
                  pass={item.pass}
                  outcome={confirmations[item.pass.lessonId]}
                  pending={pending}
                  onConfirm={() => void state.confirm(item.pass.lessonId)}
                />
              );
            case 'PAST':
              return <PastCard request={item.request} />;
          }
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>
              {failedFirst
                ? state.problem === 'OFFLINE'
                  ? t('coverRequests.offlineTitle')
                  : t('coverRequests.failedTitle')
                : t('coverRequests.emptyTitle')}
            </Text>
            <Text style={styles.emptySubtitle}>
              {failedFirst
                ? state.problem === 'OFFLINE'
                  ? t('coverRequests.problemOffline')
                  : t('coverRequests.problemFailed')
                : t('coverRequests.emptyBody')}
            </Text>
          </View>
        }
        contentContainerStyle={[groups.length === 0 ? styles.listEmpty : styles.list, { paddingHorizontal: gutter }]}
      />
    </SafeAreaView>
  );
}

// ─── Lessons ──────────────────────────────────────────────────────────────────

interface LessonLine {
  readonly lessonId: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly subjectName: string;
  readonly groupName: string;
  readonly roomName: string | null;
  readonly cancelled?: boolean;
}

/** The lessons a card is about: one heading per day, then the time, subject, group and room of each. */
function Lessons({ lessons }: { readonly lessons: readonly LessonLine[] }): React.JSX.Element {
  const styles = useStyles();
  const { t, locale } = useI18n();
  return (
    <View>
      {lessonsByDay(lessons).map((day) => (
        <View key={day.date}>
          <Text style={styles.dayHeading}>{formatDayHeading(day.date, locale)}</Text>
          {day.lessons.map((lesson) => (
            <View key={lesson.lessonId} style={styles.lesson}>
              <View style={styles.lessonTime}>
                <Text style={styles.lessonTimeText}>{formatTime(lesson.startsAt)}</Text>
                <Text style={styles.lessonTimeSub}>{formatTime(lesson.endsAt)}</Text>
              </View>
              <View style={styles.lessonBody}>
                <View style={styles.subjectRow}>
                  <Text style={[styles.lessonSubject, lesson.cancelled === true && styles.cancelledText]} numberOfLines={2}>
                    {lesson.subjectName || t('common.lesson')}
                  </Text>
                  {lesson.cancelled === true ? <Text style={styles.badgeCancelled}>{t('common.cancelled')}</Text> : null}
                </View>
                <Text style={styles.lessonMeta}>
                  {[lesson.groupName, lesson.roomName].filter((part): part is string => !!part).join('  ·  ') || t('common.noValue')}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** A lesson as a screen reader hears it in a button's name: subject and day-time. */
function spokenLesson(request: MyCoverRequest, locale: Locale): { first: string; count: number } {
  const first = request.lessons[0];
  const subject = first?.subjectName ?? '';
  const when = first ? `${formatDayHeading(first.date, locale)} ${formatTime(first.startsAt)}` : '';
  return { first: `${subject} ${when}`.trim(), count: request.lessons.length };
}

// ─── Cards ────────────────────────────────────────────────────────────────────

function Note({ tone, text }: { readonly tone: Tone; readonly text: string }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={[styles.note, { backgroundColor: colors.toneTint[tone], borderColor: colors[tone] }]} accessibilityLiveRegion="polite">
      <Text style={[styles.noteText, { color: colors[tone] }]}>{text}</Text>
    </View>
  );
}

function OpenCard({
  request,
  outcome,
  pending,
  onAnswer,
}: {
  readonly request: MyCoverRequest;
  readonly outcome: AnswerOutcome | undefined;
  readonly pending: Pending | null;
  readonly onAnswer: (choice: 'YES' | 'NO') => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const spoken = spokenLesson(request, locale);
  const summary = t('coverRequests.summary', spoken);

  // A yes or a no that went through turns the card into its confirmation; the
  // buttons stay for a refusal by rule, no connection or a failure, which are
  // not answers.
  if (outcome?.kind === 'ACCEPTED' || outcome?.kind === 'DECLINED') {
    const accepted = outcome.kind === 'ACCEPTED';
    return (
      <View style={styles.card}>
        <Lessons lessons={request.lessons} />
        <View
          style={[styles.result, { backgroundColor: colors.toneTint[accepted ? 'success' : 'neutral'], borderColor: colors[accepted ? 'success' : 'neutral'] }]}
          accessibilityLiveRegion="polite"
        >
          <Text style={[styles.resultTitle, { color: colors[accepted ? 'success' : 'neutral'] }]}>
            {accepted ? t('coverRequests.accepted') : t('coverRequests.declined')}
          </Text>
          {accepted ? (
            <Text style={styles.resultBody}>
              {request.lessons.length === 1 ? t('coverRequests.acceptedHintSingle') : t('coverRequests.acceptedHint')}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  const note = outcome ? noteOf(outcome, t) : null;
  // Taken by a colleague, or ended: no buttons, the card says why.
  const answering = outcome === undefined || outcome.kind === 'REFUSED' || outcome.kind === 'OFFLINE' || outcome.kind === 'FAILED';
  const free = answering && answerable(request) && pending === null;
  const yes = pending?.kind === 'ANSWER' && pending.id === request.id && pending.answer === 'YES';
  const no = pending?.kind === 'ANSWER' && pending.id === request.id && pending.answer === 'NO';

  return (
    <View style={styles.card}>
      <Lessons lessons={request.lessons} />
      {answering ? (
        <Text style={[styles.deadline, { color: colors.warning }]}>
          {t('coverRequests.deadline', { until: untilText(request.expiresAt, locale) })}
        </Text>
      ) : null}
      {note ? <Note tone={note.tone} text={note.text} /> : null}
      {answering ? (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.primary, !free && styles.disabled]}
            onPress={() => onAnswer('YES')}
            disabled={!free}
            accessibilityRole="button"
            accessibilityLabel={t('coverRequests.acceptA11y', { summary })}
            accessibilityState={{ disabled: !free, busy: yes }}
          >
            {yes ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <Text style={styles.primaryText}>
                {request.lessons.length === 1 ? t('coverRequests.acceptSingle') : t('coverRequests.accept')}
              </Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondary, !free && styles.disabled]}
            onPress={() => onAnswer('NO')}
            disabled={!free}
            accessibilityRole="button"
            accessibilityLabel={t('coverRequests.declineA11y', { summary })}
            accessibilityState={{ disabled: !free, busy: no }}
          >
            {no ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.secondaryText}>{t('coverRequests.decline')}</Text>}
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function PastCard({ request }: { readonly request: MyCoverRequest }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const tone = STATE_TONE[request.state];
  return (
    <View style={styles.card}>
      <Text style={[styles.stateLabel, { color: colors[tone] }]}>{t(STATE_LABEL[request.state])}</Text>
      <Lessons lessons={request.lessons} />
    </View>
  );
}

function PassCard({
  pass,
  outcome,
  pending,
  onConfirm,
}: {
  readonly pass: MyCoverPass;
  readonly outcome: ConfirmOutcome | undefined;
  readonly pending: Pending | null;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const confirmed = pass.confirmedAt !== null || outcome?.kind === 'CONFIRMED';
  const note = outcome ? noteOf(outcome, t) : null;
  const sending = pending?.kind === 'CONFIRM' && pending.id === pass.lessonId;
  const free = pending === null;
  const spoken = { subject: pass.subjectName, when: `${formatDayHeading(pass.date, locale)} ${formatTime(pass.startsAt)}` };
  return (
    <View style={styles.card}>
      <Lessons lessons={[pass]} />
      {note ? <Note tone={note.tone} text={note.text} /> : null}
      {confirmed ? (
        <Text style={[styles.confirmed, { color: colors.success }]} accessibilityLabel={t('coverRequests.passConfirmedA11y', spoken)}>
          {`✓ ${t('coverRequests.passConfirmed')}`}
        </Text>
      ) : (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.primary, !free && styles.disabled]}
            onPress={onConfirm}
            disabled={!free}
            accessibilityRole="button"
            accessibilityLabel={t('coverRequests.passConfirmA11y', spoken)}
            accessibilityState={{ disabled: !free, busy: sending }}
          >
            {sending ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryText}>{t('coverRequests.passConfirm')}</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36, paddingVertical: 60 },
  header: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  headerTitle: { fontSize: 22, fontWeight: '700', color: c.text },
  headerSubtitle: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  problem: { fontSize: 13, textAlign: 'center', paddingTop: 10 },
  list: { paddingBottom: 24 },
  listEmpty: { flexGrow: 1 },
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
  noneOpen: { fontSize: 14, color: c.textMuted, paddingHorizontal: 4, paddingBottom: 8 },
  card: {
    marginBottom: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  stateLabel: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  dayHeading: { fontSize: 13, fontWeight: '700', color: c.textMuted, marginTop: 4, marginBottom: 6 },
  lesson: { flexDirection: 'row', gap: 14, paddingVertical: 4 },
  lessonTime: { alignItems: 'center', minWidth: 52 },
  lessonTimeText: { fontSize: 15, fontWeight: '700', color: c.text },
  lessonTimeSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  lessonBody: { flex: 1 },
  subjectRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  lessonSubject: { flexShrink: 1, fontSize: 16, fontWeight: '600', color: c.text },
  cancelledText: { color: c.textMuted, textDecorationLine: 'line-through' },
  badgeCancelled: { fontSize: 12, fontWeight: '700', color: c.danger },
  lessonMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  deadline: { fontSize: 14, fontWeight: '700', marginTop: 10 },
  note: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  noteText: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  result: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  resultTitle: { fontSize: 15, fontWeight: '700' },
  resultBody: { fontSize: 14, color: c.text, marginTop: 2, lineHeight: 20 },
  confirmed: { fontSize: 15, fontWeight: '700', marginTop: 10 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  primary: {
    flex: 1,
    minHeight: 44,
    backgroundColor: c.primary,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  primaryText: { color: c.onPrimary, fontWeight: '700' },
  secondary: {
    minWidth: 88,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryText: { color: c.primary, fontWeight: '700' },
  disabled: { opacity: DISABLED_OPACITY },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 8, textAlign: 'center' },
  emptySubtitle: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 22 },
}));
