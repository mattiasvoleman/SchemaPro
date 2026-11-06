import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { useI18n } from '../../context/LocaleContext';
import { useCrisis } from '../../hooks/useCrisis';
import { formatTime, formatTimeRange } from '../../i18n/format';
import { foundHereSorted, foundPlace, pupilName, waitingKey, type AlarmBlock, type FoundHere, type MyCall, type PupilView } from '../../services/crisis';
import type { CrisisMarkState } from '../../types';
import { AlarmBanner, CountChips, STATUS_GLYPH, STATUS_TONE, WAITING_GLYPH, ageText, callTitle } from './crisisParts';
import { FoundHerePicker } from './FoundHerePicker';

// ─────────────────────────────────────────────────────────────────────────────
// The teacher's roll call (Krisläge, F2). Their own groups, each pupil with
// two big buttons and one of three states in words, glyph and colour: found,
// missing, or absent since before. The list is the gateway's, the phone's kept
// copy of it, or, when no list came, one the phone built from its cache; a tap
// is written to the phone first and shows at once with a clock until the
// gateway has it (hooks/useCrisis.ts, services/crisisQueue.ts).
//
// A pupil the teacher finds who is on none of their lists is said with one
// button per alarm ("Hittat en elev som inte står på listan"), a search of the
// school's other pupils at the gateway (FoundHerePicker), and the pupil then shows
// under the group as "Hittade hos dig" (a teacher with no group right now: under
// the alarm, "Hittade av dig"), with a clock until the gateway has it. While the
// alarm is going each of them can be taken back ("Ta tillbaka").
//
// A tap target is 52 pt, above the 48 the platforms ask for: this is used
// standing, in a crowd, on a cold hand.
// ─────────────────────────────────────────────────────────────────────────────

type Row =
  | { readonly key: string; readonly kind: 'ALARM'; readonly block: AlarmBlock }
  | { readonly key: string; readonly kind: 'CALL'; readonly block: AlarmBlock; readonly call: MyCall }
  | { readonly key: string; readonly kind: 'PUPIL'; readonly block: AlarmBlock; readonly call: MyCall; readonly pupil: PupilView }
  | { readonly key: string; readonly kind: 'HERE_HEADER'; readonly block: AlarmBlock; readonly call: MyCall }
  | { readonly key: string; readonly kind: 'HERE'; readonly block: AlarmBlock; readonly call: MyCall; readonly found: FoundHere }
  | { readonly key: string; readonly kind: 'FREE_HEADER'; readonly block: AlarmBlock }
  | { readonly key: string; readonly kind: 'FREE'; readonly block: AlarmBlock; readonly found: FoundHere };

function rowsOf(blocks: readonly AlarmBlock[]): Row[] {
  return blocks.flatMap((block): Row[] => [
    { key: `alarm:${block.key}`, kind: 'ALARM', block },
    ...freeRowsOf(block),
    ...block.calls.flatMap((call): Row[] => [
      { key: `call:${block.key}:${call.id}`, kind: 'CALL', block, call },
      ...call.pupils.map((pupil): Row => ({ key: `pupil:${block.key}:${call.id}:${pupil.studentId}`, kind: 'PUPIL', block, call, pupil })),
      ...hereRowsOf(block, call),
    ]),
  ]);
}

/** The pupils found with the teacher on a group, under a heading of their own; nothing when there are none. */
function hereRowsOf(block: AlarmBlock, call: MyCall): Row[] {
  if (call.foundHere.length === 0) return [];
  return [
    { key: `here:${block.key}:${call.id}`, kind: 'HERE_HEADER', block, call },
    ...foundHereSorted(call.foundHere).map((found): Row => ({ key: `found:${block.key}:${call.id}:${found.studentId}`, kind: 'HERE', block, call, found })),
  ];
}

/** The pupils a teacher with no group found, under the alarm; nothing when there are none. */
function freeRowsOf(block: AlarmBlock): Row[] {
  if (block.foundFree.length === 0) return [];
  return [
    { key: `free:${block.key}`, kind: 'FREE_HEADER', block },
    ...foundHereSorted(block.foundFree).map((found): Row => ({ key: `free:${block.key}:${found.studentId}`, kind: 'FREE', block, found })),
  ];
}

/**
 * Whether a teacher can say "found with me" in an alarm: the gateway's list, still open. A teacher with no
 * group right now can too: the pupil is then found in the alarm, not with a group.
 */
const canFindElsewhere = (block: AlarmBlock): boolean => !block.local && block.endedAt === null;

/** Whether a pupil found with the teacher can be taken back: while the alarm is going, and not on a list the phone built. */
const canRetract = (block: AlarmBlock): boolean => canFindElsewhere(block);

export function CrisisTeacherView({ gutter }: { readonly gutter: number }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const state = useCrisis(true);
  const rows = useMemo(() => rowsOf(state.blocks), [state.blocks]);
  // The alarm whose picker is open, by key: read from the blocks each time, so an alarm that ends under it closes it.
  const [pickingKey, setPickingKey] = useState<string | null>(null);
  const picking = pickingKey === null ? undefined : state.blocks.find((block) => block.key === pickingKey && canFindElsewhere(block));

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
              <Text style={styles.asOf}>
                {t('crisis.fromCache', { time: formatTime(state.listAsOf), age: ageText(state.now - Date.parse(state.listAsOf), t) })}
              </Text>
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
                      {item.block.startedAt ? (
                        <Text style={styles.noteText}>
                          {t('crisis.localListAge', {
                            time: formatTime(item.block.startedAt),
                            age: ageText(state.now - Date.parse(item.block.startedAt), t),
                          })}
                        </Text>
                      ) : null}
                    </Note>
                  ) : null}
                  {canFindElsewhere(item.block) ? (
                    <TouchableOpacity
                      style={styles.findElsewhere}
                      onPress={() => setPickingKey(item.block.key)}
                      accessibilityRole="button"
                      accessibilityLabel={t('crisis.foundHere.button')}
                    >
                      <Text style={styles.findElsewhereText}>{t('crisis.foundHere.button')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            case 'CALL':
              return <CallHeader call={item.call} ended={item.block.endedAt !== null} onAllFound={() => void state.markAllFound(item.call)} />;
            case 'HERE_HEADER':
              return (
                <View style={styles.hereHeader}>
                  <Text style={styles.hereTitle} accessibilityRole="header">
                    {t('crisis.foundHere.title', { count: item.call.foundHere.length })}
                  </Text>
                  <Text style={styles.callMeta}>{t('crisis.foundHere.titleHint')}</Text>
                </View>
              );
            case 'HERE':
              return (
                <FoundHereRow
                  found={item.found}
                  waiting={state.waiting.has(waitingKey(item.call.id, item.found.studentId))}
                  onRetract={canRetract(item.block) ? () => void state.retractFoundHere({ call: item.call }, item.found.studentId) : null}
                />
              );
            case 'FREE_HEADER':
              return (
                <View style={styles.hereHeader}>
                  <Text style={styles.hereTitle} accessibilityRole="header">
                    {t('crisis.foundHere.freeTitle', { count: item.block.foundFree.length })}
                  </Text>
                  <Text style={styles.callMeta}>{t('crisis.foundHere.freeTitleHint')}</Text>
                </View>
              );
            case 'FREE':
              return (
                <FoundHereRow
                  found={item.found}
                  waiting={state.waiting.has(waitingKey(foundPlace(item.block.key, null), item.found.studentId))}
                  onRetract={canRetract(item.block) ? () => void state.retractFoundHere({ alarmId: item.block.key }, item.found.studentId) : null}
                />
              );
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
      {picking ? (
        <FoundHerePicker
          block={picking}
          onClose={() => setPickingKey(null)}
          onPick={(target, pupil) => {
            setPickingKey(null);
            void state.markFoundHere(target, pupil);
          }}
        />
      ) : null}
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
  const title = callTitle(call, t);
  // The group of pupils on no lesson has no lesson time or room: its two times are the moment of the alarm.
  const noLesson = call.basis === 'NO_LESSON';
  const meta = [noLesson ? '' : formatTimeRange(call.lessonStartsAt, call.lessonEndsAt), call.roomName]
    .filter((part): part is string => !!part)
    .join('  ·  ');
  const open = call.counts.unreported;
  return (
    <View style={styles.callHeader}>
      <Text style={styles.callTitle} accessibilityRole="header" numberOfLines={2}>
        {title}
      </Text>
      {meta !== '' ? <Text style={styles.callMeta}>{meta}</Text> : null}
      {noLesson ? <Text style={styles.callMeta}>{t('crisis.noLessonHint')}</Text> : null}
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

/**
 * A pupil found with this teacher who is on another list: the name, the class, the state in words with its
 * glyph (and the clock while the gateway has not got the mark). Not found or missing buttons: only "found" is
 * ever said of them. While the alarm is going, "Ta tillbaka" takes them back (the pupil is unmarked again).
 */
function FoundHereRow({
  found,
  waiting,
  onRetract,
}: {
  readonly found: FoundHere;
  readonly waiting: boolean;
  readonly onRetract: (() => void) | null;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const name = pupilName(found) || t('common.noValue');
  return (
    <View style={[styles.pupil, { borderLeftColor: colors.success }]}>
      <View
        style={styles.pupilInfo}
        accessible
        accessibilityLabel={t(waiting ? 'crisis.foundHere.rowWaitingA11y' : 'crisis.foundHere.rowA11y', { name })}
      >
        <Text style={styles.pupilName} numberOfLines={2}>
          {name}
        </Text>
        {found.className ? <Text style={styles.callMeta}>{found.className}</Text> : null}
        <Text style={[styles.pupilStatus, { color: colors.success }]}>{`${STATUS_GLYPH.FOUND} ${t('crisis.foundHere.row')}`}</Text>
        {waiting ? <Text style={[styles.pupilWaiting, { color: colors.warning }]}>{`${WAITING_GLYPH} ${t('crisis.waitingRow')}`}</Text> : null}
      </View>
      {onRetract ? (
        <TouchableOpacity
          style={styles.retract}
          onPress={onRetract}
          hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
          accessibilityRole="button"
          accessibilityLabel={t('crisis.foundHere.retractA11y', { name })}
        >
          <Text style={styles.retractText}>{t('crisis.foundHere.retract')}</Text>
        </TouchableOpacity>
      ) : null}
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
  findElsewhere: {
    marginTop: 12,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: c.primary,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  findElsewhereText: { color: c.primary, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  retract: {
    minWidth: 92,
    minHeight: 52,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: c.borderStrong,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  retractText: { fontSize: 15, fontWeight: '800', color: c.text },
  hereHeader: { marginTop: 14 },
  hereTitle: { fontSize: 16, fontWeight: '800', color: c.text },
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
