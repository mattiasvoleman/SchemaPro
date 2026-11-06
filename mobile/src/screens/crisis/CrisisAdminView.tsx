import React, { useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { useI18n } from '../../context/LocaleContext';
import { useCrisisAdmin, type AdminFailureNote } from '../../hooks/useCrisisAdmin';
import { formatTime } from '../../i18n/format';
import type { MessageKey } from '../../i18n';
import { Column } from '../../layout/Column';
import { GUTTER, READABLE_MAX } from '../../layout/responsive';
import { missingPupils, silentTeachers, uncoveredCalls, type AlarmDetail, type CrisisKind, type CrisisMode } from '../../services/crisis';
import { AlarmBanner, CountChips, STATUS_GLYPH } from './crisisParts';

// ─────────────────────────────────────────────────────────────────────────────
// The administrator's side of an alarm (Krisläge, F2): start it (a real one
// asks twice), watch the roll call as it comes in (how many groups are done,
// who has not answered, which pupils are missing) and end it. Everything is
// live and nothing is queued: an alarm that starts or ends on a delay is a
// different alarm, so a phone with no network is told so.
//
// The gateway decides who may start (the head teacher chooses the profiles):
// the answer is worded here, not guessed beforehand.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS: readonly CrisisKind[] = ['EVACUATION', 'LOCKDOWN'];
const MODES: readonly CrisisMode[] = ['DRILL', 'LIVE'];

/** Words for a refusal. A start refused because one is going says which. */
function failureKey(note: AdminFailureNote): MessageKey {
  if (note.action === 'AWAY') {
    if (note.code === 'ENDED' || note.code === 'NOT_FOUND') return `crisis.admin.endFailed.${note.code}` as MessageKey;
    return note.code === 'OFFLINE' ? 'crisis.admin.awayOffline' : 'crisis.admin.awayFailed';
  }
  if (note.action === 'END') {
    return note.code === 'ENDED' || note.code === 'NOT_FOUND' || note.code === 'OFFLINE'
      ? (`crisis.admin.endFailed.${note.code}` as MessageKey)
      : 'crisis.admin.endFailed.FAILED';
  }
  switch (note.code) {
    case 'NOT_YOURS':
      return 'crisis.admin.startFailed.NOT_YOURS';
    case 'ALARM_OPEN':
      return note.mode === 'LIVE' ? 'crisis.admin.startFailed.ALARM_OPEN_LIVE' : 'crisis.admin.startFailed.ALARM_OPEN_DRILL';
    case 'OFFLINE':
      return 'crisis.admin.startFailed.OFFLINE';
    default:
      return 'crisis.admin.startFailed.FAILED';
  }
}

export function CrisisAdminView({ gutter }: { readonly gutter: number }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const state = useCrisisAdmin(true);
  // A drill is the default: a real alarm is a choice, made with the mode selector and then confirmed.
  const [kind, setKind] = useState<CrisisKind>('EVACUATION');
  const [mode, setMode] = useState<CrisisMode>('DRILL');

  if (state.isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const starting = state.busy?.kind === 'START';
  const live = mode === 'LIVE';

  const confirmStart = (): void => {
    if (!live) {
      void state.start(kind, mode);
      return;
    }
    // A real alarm empties a building and reaches every phone of the staff: asked twice.
    Alert.alert(t('crisis.admin.confirmLiveTitle'), t('crisis.admin.confirmLiveBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('crisis.admin.confirmLiveYes'), style: 'destructive', onPress: () => void state.start(kind, mode) },
    ]);
  };

  const confirmEnd = (detail: AlarmDetail): void => {
    const drill = detail.alarm.mode === 'DRILL';
    // What the alarm stands at when it is ended, each figure for itself: a pupil not in the building is neither found nor missing.
    const { found, missing, away, unreported } = detail.alarm.counts;
    const message = `${t('crisis.admin.confirmEndBody')}\n\n${t('crisis.admin.confirmEndCounts', { found, missing, away, unreported })}`;
    Alert.alert(t(drill ? 'crisis.admin.confirmEndDrillTitle' : 'crisis.admin.confirmEndTitle'), message, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('crisis.admin.confirmEndYes'), style: 'destructive', onPress: () => void state.end(detail.alarm.id) },
    ]);
  };

  const confirmAway = (detail: AlarmDetail, pupil: { readonly studentId: string; readonly name: string; readonly callId: string }): void => {
    // "Not in the building" takes a pupil off the list of those missing: asked once, with what it means.
    Alert.alert(t('crisis.admin.awayConfirmTitle'), t('crisis.admin.awayConfirmBody', { name: pupil.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('crisis.admin.awayConfirmYes'), style: 'destructive', onPress: () => void state.away(detail.alarm, pupil.callId, pupil.studentId) },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          {t('crisis.title')}
        </Text>
        {state.updatedAt !== null ? (
          <Text style={styles.headerSubtitle}>{t('crisis.admin.updatedAt', { time: formatTime(state.updatedAt) })}</Text>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={state.isRefreshing}
            onRefresh={state.refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
      >
        <Column max={READABLE_MAX}>
          {state.problem !== null ? (
            <Note tone={state.problem === 'OFFLINE' ? 'warning' : 'danger'}>
              {state.hasLoaded
                ? t('crisis.admin.updateFailed')
                : t(state.problem === 'OFFLINE' ? 'crisis.admin.offlineBody' : 'crisis.admin.loadFailedTitle')}
            </Note>
          ) : null}

          {state.details.map((detail) => (
            <Going
              key={detail.alarm.id}
              detail={detail}
              ending={state.busy?.kind === 'END' && state.busy.alarmId === detail.alarm.id}
              awayId={state.busy?.kind === 'AWAY' && state.busy.alarmId === detail.alarm.id ? state.busy.studentId : null}
              failure={state.failure?.action === 'AWAY' ? state.failure : null}
              disabled={state.busy !== null}
              onEnd={() => confirmEnd(detail)}
              onAway={(pupil) => confirmAway(detail, pupil)}
            />
          ))}

          <Text style={styles.sectionHeader} accessibilityRole="header">
            {t('crisis.admin.startTitle')}
          </Text>

          <Text style={styles.label}>{t('crisis.admin.kindLabel')}</Text>
          <View style={styles.choices} accessibilityRole="radiogroup">
            {KINDS.map((option) => (
              <Choice key={option} selected={kind === option} tone="neutral" label={t(`crisis.kind.${option}`)} onPress={() => setKind(option)} />
            ))}
          </View>

          <Text style={styles.label}>{t('crisis.admin.modeLabel')}</Text>
          <View style={styles.choices} accessibilityRole="radiogroup">
            {MODES.map((option) => (
              <Choice
                key={option}
                selected={mode === option}
                tone={option === 'LIVE' ? 'danger' : 'warning'}
                label={t(`crisis.mode.${option}`)}
                onPress={() => setMode(option)}
              />
            ))}
          </View>
          <Text style={styles.hint}>{t(live ? 'crisis.admin.modeLiveHint' : 'crisis.admin.modeDrillHint')}</Text>

          {state.failure && state.failure.action !== 'AWAY' ? (
            <View style={[styles.note, { backgroundColor: colors.toneTint.danger, borderColor: colors.danger }]} accessibilityLiveRegion="polite">
              <Text style={styles.noteText}>{t(failureKey(state.failure))}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.start, { backgroundColor: live ? colors.danger : colors.warning }, state.busy !== null && styles.disabled]}
            onPress={confirmStart}
            disabled={state.busy !== null}
            accessibilityRole="button"
            accessibilityState={{ disabled: state.busy !== null, busy: starting }}
          >
            {starting ? (
              <ActivityIndicator color={colors.onTone} />
            ) : (
              <Text style={[styles.startText, { color: colors.onTone }]}>{t(live ? 'crisis.admin.startLive' : 'crisis.admin.startDrill')}</Text>
            )}
          </TouchableOpacity>
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Note({ tone, children }: { readonly tone: Tone; readonly children: string }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={[styles.note, { backgroundColor: colors.toneTint[tone], borderColor: colors[tone] }]} accessibilityLiveRegion="polite">
      <Text style={styles.noteText}>{children}</Text>
    </View>
  );
}

function Choice({
  selected,
  tone,
  label,
  onPress,
}: {
  readonly selected: boolean;
  readonly tone: Tone;
  readonly label: string;
  readonly onPress: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <TouchableOpacity
      style={[styles.choice, selected ? { backgroundColor: colors[tone], borderColor: colors[tone] } : { backgroundColor: colors.surface, borderColor: colors.borderStrong }]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.choiceText, { color: selected ? colors.onTone : colors.text }]}>{`${selected ? STATUS_GLYPH.FOUND : ' '} ${label}`.trim()}</Text>
    </TouchableOpacity>
  );
}

/**
 * An alarm that is going: the banner, the counts (not in the building among them, for itself), who has not
 * answered, who is missing, with "Inte i huset" for each of them, and the end.
 */
function Going({
  detail,
  ending,
  awayId,
  failure,
  disabled,
  onEnd,
  onAway,
}: {
  readonly detail: AlarmDetail;
  readonly ending: boolean;
  /** The pupil whose "inte i huset" is in the air. */
  readonly awayId: string | null;
  /** Why the last "inte i huset" did not go through. */
  readonly failure: AdminFailureNote | null;
  readonly disabled: boolean;
  readonly onEnd: () => void;
  readonly onAway: (pupil: { readonly studentId: string; readonly name: string; readonly callId: string }) => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const { alarm } = detail;
  const silent = silentTeachers(detail);
  const missing = missingPupils(detail);
  const uncovered = uncoveredCalls(detail);
  return (
    <View>
      <AlarmBanner
        local={false}
        kind={alarm.kind}
        mode={alarm.mode}
        startedAt={alarm.startedAt}
        endedAt={alarm.endedAt}
        startedBy={alarm.startedBy}
      />

      <View style={styles.card}>
        <Text style={styles.progress}>{t('crisis.admin.groupsDone', { done: alarm.callsComplete, total: alarm.calls })}</Text>
        <Text style={styles.progressSub}>{t('crisis.admin.teachersAnswered', { answered: alarm.teachersAnswered, total: alarm.teachers })}</Text>
        <CountChips counts={alarm.counts} />
        {alarm.unlisted > 0 ? <Text style={styles.line}>{t('crisis.admin.unlisted', { count: alarm.unlisted })}</Text> : null}

        <Text style={styles.cardHeader} accessibilityRole="header">
          {t('crisis.admin.missingTitle')}
        </Text>
        {missing.length === 0 ? (
          <Text style={styles.line}>{t('crisis.admin.noneMissing')}</Text>
        ) : (
          missing.map((pupil) => (
            <View key={`${pupil.studentId}:${pupil.callId}`} style={styles.missingRow}>
              <Text style={[styles.line, styles.missingName, { color: colors.danger, fontWeight: '700' }]}>
                {`${STATUS_GLYPH.MISSING} ${t('crisis.admin.missingLine', { name: pupil.name, group: pupil.basis === 'NO_LESSON' ? t('crisis.noLesson') : pupil.groupName })}`}
              </Text>
              <TouchableOpacity
                style={[styles.away, (disabled || awayId === pupil.studentId) && styles.disabled]}
                onPress={() => onAway(pupil)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('crisis.admin.awayA11y', { name: pupil.name })}
                accessibilityState={{ disabled, busy: awayId === pupil.studentId }}
              >
                {awayId === pupil.studentId ? (
                  <ActivityIndicator color={colors.text} />
                ) : (
                  <Text style={styles.awayText}>{`${STATUS_GLYPH.AWAY} ${t('crisis.admin.away')}`}</Text>
                )}
              </TouchableOpacity>
            </View>
          ))
        )}
        {failure ? <Text style={[styles.line, { color: colors.danger, fontWeight: '700' }]}>{t(failureKey(failure))}</Text> : null}

        <Text style={styles.cardHeader} accessibilityRole="header">
          {t('crisis.admin.silentTitle')}
        </Text>
        {silent.length === 0 ? (
          <Text style={styles.line}>{t('crisis.admin.allAnswered')}</Text>
        ) : (
          silent.map((teacher) => (
            <Text key={teacher.name} style={styles.line}>
              {t('crisis.admin.silentLine', { name: teacher.name, groups: teacher.groups.join(', ') })}
            </Text>
          ))
        )}

        {uncovered.length > 0 ? <Text style={[styles.line, { color: colors.warning, fontWeight: '700' }]}>{t('crisis.admin.uncovered', { count: uncovered.length })}</Text> : null}
      </View>

      <TouchableOpacity
        style={[styles.end, disabled && styles.disabled]}
        onPress={onEnd}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled, busy: ending }}
      >
        {ending ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.endText}>{t(alarm.mode === 'DRILL' ? 'crisis.admin.endDrill' : 'crisis.admin.end')}</Text>}
      </TouchableOpacity>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36, paddingVertical: 60 },
  header: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  headerTitle: { fontSize: 22, fontWeight: '700', color: c.text },
  headerSubtitle: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  content: { paddingBottom: 40, paddingHorizontal: GUTTER },
  note: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  noteText: { fontSize: 14, fontWeight: '600', color: c.text, lineHeight: 20 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
    paddingTop: 26,
    paddingBottom: 4,
  },
  label: { fontSize: 14, fontWeight: '700', color: c.text, marginTop: 14, marginBottom: 6 },
  choices: { flexDirection: 'row', gap: 8 },
  choice: { flex: 1, minHeight: 52, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  choiceText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  hint: { fontSize: 13, color: c.textMuted, marginTop: 8, lineHeight: 19 },
  start: { marginTop: 16, minHeight: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  startText: { fontSize: 17, fontWeight: '800' },
  card: { marginTop: 10, padding: 14, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  progress: { fontSize: 18, fontWeight: '800', color: c.text },
  progressSub: { fontSize: 14, color: c.textMuted, marginTop: 2 },
  cardHeader: { fontSize: 13, fontWeight: '800', color: c.textMuted, marginTop: 16, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 },
  line: { fontSize: 15, color: c.text, marginTop: 3, lineHeight: 21 },
  missingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4 },
  missingName: { flex: 1 },
  away: {
    minHeight: 48,
    minWidth: 112,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: c.borderStrong,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  awayText: { fontSize: 14, fontWeight: '800', color: c.text },
  end: {
    marginTop: 12,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: c.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  endText: { color: c.danger, fontSize: 16, fontWeight: '800' },
  disabled: { opacity: DISABLED_OPACITY },
}));
