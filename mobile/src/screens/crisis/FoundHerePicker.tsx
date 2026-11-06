import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { useI18n } from '../../context/LocaleContext';
import type { FoundTarget } from '../../hooks/useCrisis';
import {
  SEARCH_LIMIT,
  SEARCH_MIN_CHARS,
  isTransportFailure,
  pupilName,
  searchOtherPupils,
  type AlarmBlock,
  type MyCall,
  type OtherPupil,
} from '../../services/crisis';
import { noNetwork } from '../../services/network/deviceOffline';
import { callTitle } from './crisisParts';

// ─────────────────────────────────────────────────────────────────────────────
// "Found with me" (Krisläge, F2): a teacher meets a pupil who is on none of
// their lists, and says so. The pupil is looked up at the gateway as the teacher
// types (POST /crisis/mine/pupils: name or class, at least two characters, at
// most 25 names, the teacher's own pupils left out, a pupil whose identity is
// protected included), because the school's pupils are not kept on the phone.
// The question waits for the typing to pause (DEBOUNCE_MS), a question that
// is overtaken is abandoned and its answer, if it comes, is not looked at, and the
// answer is kept in this component and nowhere else. With no network the search
// cannot be made, and the picker says so rather than show an empty list.
//
// Only FOUND is ever offered: a pupil who is not on the list cannot be missing
// from it.
//
// A teacher with more than one group in the alarm says which of them the pupil
// was found with; the group that is going on (LESSON) is chosen to begin with.
// A teacher with none right now says only that they found the pupil in the alarm.
// The picker is mounted when it is opened and gone when it is closed, so the
// search starts empty each time.
// ─────────────────────────────────────────────────────────────────────────────

/** How long the typing must pause before the gateway is asked. */
export const DEBOUNCE_MS = 250;
/** A question not answered by then is a network that is not there. */
export const SEARCH_TIMEOUT_MS = 8_000;

/** The group a pupil is most likely found with: the lesson that is going on, else the first. */
export function defaultCall(calls: readonly MyCall[]): MyCall | undefined {
  return calls.find((call) => call.basis === 'LESSON') ?? calls[0];
}

type Search =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'SEARCHING' }
  | { readonly kind: 'RESULT'; readonly pupils: readonly OtherPupil[] }
  | { readonly kind: 'OFFLINE' }
  | { readonly kind: 'FAILED' };

export function FoundHerePicker({
  block,
  onPick,
  onClose,
}: {
  readonly block: AlarmBlock;
  readonly onPick: (target: FoundTarget, pupil: OtherPupil) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [search, setSearch] = useState<Search>({ kind: 'IDLE' });

  const call = block.calls.find((candidate) => candidate.id === chosen) ?? defaultCall(block.calls);
  const alarmId = block.key;

  useEffect(() => {
    const text = query.trim();
    if ([...text].length < SEARCH_MIN_CHARS) {
      setSearch({ kind: 'IDLE' });
      return undefined;
    }
    const controller = new AbortController();
    let current = true;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const pause = setTimeout(() => {
      setSearch({ kind: 'SEARCHING' });
      giveUp = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      searchOtherPupils(alarmId, text, { signal: controller.signal })
        .then((pupils) => {
          if (current) setSearch({ kind: 'RESULT', pupils });
        })
        .catch(async (error: unknown) => {
          if (!current) return;
          const offline = isTransportFailure(error) || (await noNetwork());
          if (current) setSearch({ kind: offline ? 'OFFLINE' : 'FAILED' });
        })
        .finally(() => clearTimeout(giveUp));
    }, DEBOUNCE_MS);
    // A newer question, or the picker closing, abandons this one: nothing it answers is looked at.
    return () => {
      current = false;
      clearTimeout(pause);
      clearTimeout(giveUp);
      controller.abort();
    };
  }, [query, alarmId]);

  // A pupil already found with this teacher is in the list under the alarm, not offered again.
  const skip = useMemo(
    () => new Set((call ? call.foundHere : block.foundFree).map((held) => held.studentId)),
    [call, block.foundFree],
  );
  const pupils = search.kind === 'RESULT' ? search.pupils.filter((pupil) => !skip.has(pupil.studentId)) : [];
  const target: FoundTarget = call ? { call } : { alarmId };
  const where = call ? callTitle(call, t) : '';

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { paddingTop: Platform.OS === 'android' ? insets.top : 0, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {t('crisis.foundHere.pickerTitle')}
          </Text>
          <TouchableOpacity style={styles.close} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('crisis.foundHere.close')}>
            <Text style={styles.closeText}>{t('crisis.foundHere.close')}</Text>
          </TouchableOpacity>
        </View>

        {block.calls.length > 1 ? (
          <View style={styles.groups}>
            <Text style={styles.label}>{t('crisis.foundHere.whichGroup')}</Text>
            <View style={styles.chips}>
              {block.calls.map((candidate) => {
                const selected = candidate.id === call?.id;
                const title = callTitle(candidate, t);
                return (
                  <TouchableOpacity
                    key={candidate.id}
                    style={[styles.chip, selected && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    onPress={() => setChosen(candidate.id)}
                    accessibilityRole="button"
                    accessibilityLabel={title}
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.chipText, selected && { color: colors.onPrimary }]} numberOfLines={1}>
                      {title}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}

        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          accessibilityLabel={t('crisis.foundHere.searchLabel')}
          placeholder={t('crisis.foundHere.searchPlaceholder')}
          placeholderTextColor={colors.textMuted}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />

        <View accessibilityLiveRegion="polite">
          {search.kind === 'IDLE' ? <Text style={styles.note}>{t('crisis.foundHere.hint')}</Text> : null}
          {search.kind === 'SEARCHING' ? <Text style={styles.note}>{t('crisis.foundHere.searching')}</Text> : null}
          {search.kind === 'OFFLINE' ? <Text style={[styles.note, { color: colors.warning, fontWeight: '700' }]}>{t('crisis.foundHere.needsNetwork')}</Text> : null}
          {search.kind === 'FAILED' ? <Text style={[styles.note, { color: colors.danger, fontWeight: '700' }]}>{t('crisis.foundHere.searchFailed')}</Text> : null}
          {search.kind === 'RESULT' && pupils.length === 0 ? <Text style={styles.note}>{t('crisis.foundHere.none')}</Text> : null}
          {search.kind === 'RESULT' && search.pupils.length >= SEARCH_LIMIT ? (
            <Text style={styles.note}>{t('crisis.foundHere.more', { count: SEARCH_LIMIT })}</Text>
          ) : null}
        </View>

        <FlatList<OtherPupil>
          data={pupils}
          keyExtractor={(pupil) => pupil.studentId}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          renderItem={({ item }) => {
            const name = pupilName(item) || t('common.noValue');
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() => onPick(target, item)}
                accessibilityRole="button"
                accessibilityLabel={call ? t('crisis.foundHere.pickA11y', { name, group: where }) : t('crisis.foundHere.pickFreeA11y', { name })}
              >
                <Text style={styles.name} numberOfLines={2}>
                  {name}
                </Text>
                {item.className ? <Text style={styles.className}>{item.className}</Text> : null}
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={styles.list}
        />
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14 },
  title: { flex: 1, fontSize: 20, fontWeight: '800', color: c.text },
  close: { minHeight: 48, minWidth: 48, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
  closeText: { fontSize: 16, fontWeight: '700', color: c.primary },
  groups: { marginBottom: 8 },
  label: { fontSize: 13, color: c.textMuted, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 14 },
  chipText: { fontSize: 14, fontWeight: '700', color: c.text },
  input: {
    minHeight: 52,
    backgroundColor: c.surface,
    borderColor: c.borderStrong,
    borderWidth: 1,
    borderRadius: 10,
    color: c.text,
    fontSize: 17,
    paddingHorizontal: 12,
  },
  note: { fontSize: 14, color: c.textMuted, marginTop: 10, lineHeight: 20 },
  list: { paddingTop: 8, paddingBottom: 24 },
  row: {
    minHeight: 52,
    marginTop: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    justifyContent: 'center',
  },
  name: { fontSize: 17, fontWeight: '700', color: c.text },
  className: { fontSize: 13, color: c.textMuted, marginTop: 2 },
}));
