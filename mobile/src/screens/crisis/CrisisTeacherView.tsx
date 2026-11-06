import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { useI18n } from '../../context/LocaleContext';
import { useCrisis } from '../../hooks/useCrisis';
import { formatTime, formatTimeRange } from '../../i18n/format';
import { pupilName, type AlarmBlock, type MyCall, type PupilView } from '../../services/crisis';
import type { CrisisMarkState } from '../../types';
import { AlarmBanner, CountChips, STATUS_GLYPH, STATUS_TONE, WAITING_GLYPH } from './crisisParts';

// ─────────────────────────────────────────────────────────────────────────────
// The teacher's roll call (Krisläge, F2). Their own groups, each pupil with
// two big buttons and one of three states in words, glyph and colour: found,
// missing, or absent since before. The list is the gateway's, the phone's kept
// copy of it, or, when no list came, one the phone built from its cache; a tap
// is written to the phone first and shows at once with a clock until the
// gateway has it (hooks/useCrisis.ts, services/crisisQueue.ts).
//
// A tap target is 52 pt, above the 48 the platforms ask for: this is used
// standing, in a crowd, on a cold hand.
// ─────────────────────────────────────────────────────────────────────────────

type Row =
  | { readonly key: string; readonly kind: 'ALARM'; readonly block: AlarmBlock }
  | { readonly key: string; readonly kind: 'CALL'; readonly block: AlarmBlock; readonly call: MyCall }
  | { readonly key: string; readonly kind: 'PUPIL'; readonly block: AlarmBlock; readonly call: MyCall; readonly pupil: PupilView };

function rowsOf(blocks: readonly AlarmBlock[]): Row[] {
  return blocks.flatMap((block): Row[] => [
    { key: `alarm:${block.key}`, kind: 'ALARM', block },
    ...block.calls.flatMap((call): Row[] => [
      { key: `call:${block.key}:${call.id}`, kind: 'CALL', block, call },
      ...call.pupils.map((pupil): Row => ({ key: `pupil:${block.key}:${call.id}:${pupil.studentId}`, kind: 'PUPIL', block, call, pupil })),
    ]),
  ]);
}

export function CrisisTeacherView({ gutter }: { readonly gutter: number }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const state = useCrisis(true);
  const rows = useMemo(() => rowsOf(state.blocks), [state.blocks]);

  if (state.isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const noList = state.blocks.length === 0 && state.problem !== null && !state.hasLoaded;

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          {t('crisis.title')}
        </Text>
      </View>

      <FlatList<Row>
        data={rows}
        keyExtractor={(row) => row.key}
        // A group is a screen or two of names: drawn at once, so that a fast scroll down the list is never blank.
        initialNumToRender={24}
        windowSize={11}
        refreshControl={
          <RefreshControl
            refreshing={state.isRefreshing}
            onRefresh={state.refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListHeaderComponent={
          <View>
            {state.dropped.length > 0 ? (
              <Note tone="danger">
                <Text style={styles.noteTitle}>{t('crisis.dropped.title', { count: state.dropped.reduce((n, d) => n + d.count, 0) })}</Text>
                {state.dropped.map((d) => (
                  <Text key={d.reason} style={styles.noteText}>
                    {t(`crisis.dropped.${d.reason}`)}
                  </Text>
                ))}
                <TouchableOpacity
                  style={styles.noteButton}
                  onPress={state.dismissDropped}
                  accessibilityRole="button"
                  accessibilityLabel={t('crisis.dropped.dismiss')}
                >
                  <Text style={styles.noteButtonText}>{t('crisis.dropped.dismiss')}</Text>
                </TouchableOpacity>
              </Note>
            ) : null}
            {state.saveFailed ? (
              <Note tone="danger">
                <Text style={styles.noteTitle}>{t('crisis.saveFailed')}</Text>
              </Note>
            ) : null}
            {state.problem !== null && state.blocks.length > 0 ? (
              <Note tone={state.problem === 'OFFLINE' ? 'warning' : 'danger'}>
                <Text style={styles.noteText}>{state.problem === 'OFFLINE' ? t('crisis.problemOffline') : t('crisis.problemFailed')}</Text>
              </Note>
            ) : null}
            {state.listAsOf !== null && state.blocks.some((block) => !block.local) ? (
              <Text style={styles.asOf}>{t('crisis.fromCache', { time: formatTime(state.listAsOf) })}</Text>
            ) : null}
            {state.waitingCount > 0 ? (
              <Note tone="warning">
                <Text style={styles.noteTitle} accessibilityLiveRegion="polite">
                  {`${WAITING_GLYPH} ${t('crisis.waiting', { count: state.waitingCount })}`}
                </Text>
              </Note>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          switch (item.kind) {
            case 'ALARM':
              return (
                <View>
                  <AlarmBanner
                    local={item.block.local}
                    kind={item.block.kind}
                    mode={item.block.mode}
                    startedAt={item.block.startedAt}
                    endedAt={item.block.endedAt}
                  />
                  {item.block.local ? (
                    <Note tone="warning">
                      <Text style={styles.noteTitle}>{t('crisis.localList')}</Text>
                      <Text style={styles.noteText}>{t('crisis.localListHint')}</Text>
                    </Note>
                  ) : null}
                </View>
              );
            case 'CALL':
              return <CallHeader call={item.call} ended={item.block.endedAt !== null} onAllFound={() => void state.markAllFound(item.call)} />;
            case 'PUPIL':
              return (
                <PupilRow
                  pupil={item.pupil}
                  waiting={state.waiting.has(`${item.call.id}:${item.pupil.studentId}`)}
                  ended={item.block.endedAt !== null}
                  onMark={(markState) => void state.mark(item.call, item.pupil.studentId, markState)}
                />
              );
          }
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>{noList ? t('crisis.noListTitle') : t('crisis.emptyTitle')}</Text>
            <Text style={styles.emptySubtitle}>{noList ? t('crisis.noListBody') : t('crisis.emptyBody')}</Text>
          </View>
        }
        contentContainerStyle={[rows.length === 0 ? styles.listEmpty : styles.list, { paddingHorizontal: gutter }]}
      />
    </SafeAreaView>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Note({ tone, children }: { readonly tone: Tone; readonly children: React.ReactNode }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={[styles.note, { backgroundColor: colors.toneTint[tone], borderColor: colors[tone] }]} accessibilityLiveRegion="polite">
      {children}
    </View>
  );
}

/** A group: what it is, when and where, how far the count has come, and the one tap that says everyone is here. */
function CallHeader({
  call,
  ended,
  onAllFound,
}: {
  readonly call: MyCall;
  readonly ended: boolean;
  readonly onAllFound: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const subject = call.subjectName || t('common.lesson');
  const title = call.groupName ? `${call.groupName} · ${subject}` : subject;
  const meta = [formatTimeRange(call.lessonStartsAt, call.lessonEndsAt), call.roomName].filter((part): part is string => !!part).join('  ·  ');
  const open = call.counts.unreported;
  return (
    <View style={styles.callHeader}>
      <Text style={styles.callTitle} accessibilityRole="header" numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.callMeta}>{meta}</Text>
      {call.basis === 'NEXT_LESSON' ? (
        <Text style={[styles.nextLesson, { color: colors.warning }]}>{t('crisis.nextLesson')}</Text>
      ) : null}
      {call.colleagues.length > 0 ? <Text style={styles.callMeta}>{t('crisis.colleagues', { names: call.colleagues.join(', ') })}</Text> : null}
      {open === 0 && call.counts.pupils > 0 ? (
        <Text style={[styles.allMarked, { color: colors.success }]}>{`${STATUS_GLYPH.FOUND} ${t('crisis.allMarked')}`}</Text>
      ) : (
        <CountChips counts={call.counts} />
      )}
      {!ended && open > 0 ? (
        <TouchableOpacity
          style={styles.allFound}
          onPress={onAllFound}
          accessibilityRole="button"
          accessibilityLabel={t('crisis.allFoundA11y', { group: title })}
        >
          <Text style={styles.allFoundText}>{`${STATUS_GLYPH.FOUND} ${t('crisis.allFound')}`}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * A pupil: the name, the state in words with its glyph (and the clock while the
 * gateway has not got the tap), and the two buttons. The pressed one is filled,
 * the other outlined: a tap on the state a pupil already has changes nothing.
 * A pupil absent since before can still be tapped found: a mark overrules it.
 */
function PupilRow({
  pupil,
  waiting,
  ended,
  onMark,
}: {
  readonly pupil: PupilView;
  readonly waiting: boolean;
  readonly ended: boolean;
  readonly onMark: (state: CrisisMarkState) => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const name = pupilName(pupil) || t('common.noValue');
  const tone = STATUS_TONE[pupil.status];
  const status = t(`crisis.status.${pupil.status}`);
  const prior = pupil.status === 'ABSENT_BEFORE' && pupil.priorAbsentSource ? t(`crisis.priorSource.${pupil.priorAbsentSource}`) : '';
  return (
    <View style={[styles.pupil, { borderLeftColor: colors[tone] }]}>
      <View
        style={styles.pupilInfo}
        accessible
        accessibilityLabel={t(waiting ? 'crisis.rowWaitingA11y' : 'crisis.rowA11y', { name, status })}
      >
        <Text style={styles.pupilName} numberOfLines={2}>
          {name}
        </Text>
        <Text style={[styles.pupilStatus, { color: colors[tone] }]}>{`${STATUS_GLYPH[pupil.status]} ${status}${prior ? ` · ${prior}` : ''}`}</Text>
        {waiting ? <Text style={[styles.pupilWaiting, { color: colors.warning }]}>{`${WAITING_GLYPH} ${t('crisis.waitingRow')}`}</Text> : null}
      </View>
      <View style={styles.buttons}>
        <MarkButton state="FOUND" selected={pupil.status === 'FOUND'} disabled={ended} name={name} onPress={() => onMark('FOUND')} />
        <MarkButton state="MISSING" selected={pupil.status === 'MISSING'} disabled={ended} name={name} onPress={() => onMark('MISSING')} />
      </View>
    </View>
  );
}

function MarkButton({
  state,
  selected,
  disabled,
  name,
  onPress,
}: {
  readonly state: CrisisMarkState;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly name: string;
  readonly onPress: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const tone: Tone = state === 'FOUND' ? 'success' : 'danger';
  const glyph = STATUS_GLYPH[state];
  const word = state === 'FOUND' ? t('crisis.found') : t('crisis.missing');
  return (
    <TouchableOpacity
      style={[
        styles.mark,
        selected ? { backgroundColor: colors[tone], borderColor: colors[tone] } : { backgroundColor: colors.surface, borderColor: colors[tone] },
        disabled && styles.disabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      accessibilityRole="button"
      accessibilityLabel={t(state === 'FOUND' ? 'crisis.markFoundA11y' : 'crisis.markMissingA11y', { name })}
      accessibilityState={{ selected, disabled }}
    >
      <Text style={[styles.markText, { color: selected ? colors.onTone : colors[tone] }]}>{`${glyph} ${word}`}</Text>
    </TouchableOpacity>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36, paddingVertical: 60 },
  header: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  headerTitle: { fontSize: 22, fontWeight: '700', color: c.text },
  list: { paddingBottom: 32 },
  listEmpty: { flexGrow: 1 },
  asOf: { fontSize: 13, color: c.textMuted, marginTop: 10 },
  note: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  noteTitle: { fontSize: 15, fontWeight: '700', color: c.text, lineHeight: 21 },
  noteText: { fontSize: 14, color: c.text, marginTop: 2, lineHeight: 20 },
  noteButton: {
    alignSelf: 'flex-start',
    minHeight: 48,
    marginTop: 6,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.primary,
  },
  noteButtonText: { color: c.primary, fontWeight: '700' },
  callHeader: { marginTop: 22, paddingBottom: 8 },
  callTitle: { fontSize: 19, fontWeight: '800', color: c.text },
  callMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  nextLesson: { fontSize: 14, fontWeight: '700', marginTop: 4 },
  allMarked: { fontSize: 15, fontWeight: '700', marginTop: 8 },
  allFound: {
    marginTop: 10,
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: c.success,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  allFoundText: { color: c.onTone, fontSize: 17, fontWeight: '800' },
  pupil: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 12,
    borderLeftWidth: 5,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  pupilInfo: { flex: 1 },
  pupilName: { fontSize: 17, fontWeight: '700', color: c.text },
  pupilStatus: { fontSize: 13, fontWeight: '700', marginTop: 2 },
  pupilWaiting: { fontSize: 12, fontWeight: '700', marginTop: 2 },
  buttons: { flexDirection: 'row', gap: 8 },
  mark: {
    minWidth: 92,
    minHeight: 52,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  markText: { fontSize: 15, fontWeight: '800' },
  disabled: { opacity: DISABLED_OPACITY },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 8, textAlign: 'center' },
  emptySubtitle: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 22 },
}));
