import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { useI18n } from '../../context/LocaleContext';
import { indexPupils, pupilName, searchPupils, type AlarmBlock, type MyCall, type OtherPupil } from '../../services/crisis';
import { callTitle } from './crisisParts';

// ─────────────────────────────────────────────────────────────────────────────
// "Found with me" (Krisläge, F2): a teacher meets a pupil who is on none of
// their lists, and says so. The pupils are the alarm's `others`, kept on the
// phone with the lists, so the picker works with no network: a search field
// (name or class, case and accents ignored) over a list that is drawn at most
// PICKER_LIMIT names at a time, a thousand names being a thing to search and not
// to scroll. Only FOUND is ever offered: a pupil who is not on the list cannot
// be missing from it.
//
// A teacher with more than one group in the alarm says which of them the pupil
// was found with; the group that is going on (LESSON) is chosen to begin with.
// The picker is mounted when it is opened and gone when it is closed, so the
// search starts empty each time.
// ─────────────────────────────────────────────────────────────────────────────

/** The group a pupil is most likely found with: the lesson that is going on, else the first. */
export function defaultCall(calls: readonly MyCall[]): MyCall | undefined {
  return calls.find((call) => call.basis === 'LESSON') ?? calls[0];
}

export function FoundHerePicker({
  block,
  onPick,
  onClose,
}: {
  readonly block: AlarmBlock;
  readonly onPick: (call: MyCall, pupil: OtherPupil) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);

  const call = block.calls.find((candidate) => candidate.id === chosen) ?? defaultCall(block.calls);
  const index = useMemo(() => indexPupils(block.others), [block.others]);
  // A pupil already found with this teacher on the group is in "Hittade hos dig", not offered again.
  const skip = useMemo(() => new Set((call?.foundHere ?? []).map((held) => held.studentId)), [call]);
  const result = useMemo(() => searchPupils(index, query, { skip }), [index, query, skip]);
  const typed = query.trim() !== '';

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

        {block.others.length === 0 ? (
          <Text style={styles.note}>{t('crisis.foundHere.noOthers')}</Text>
        ) : !typed ? (
          <Text style={styles.note}>{t('crisis.foundHere.hint')}</Text>
        ) : result.total === 0 ? (
          <Text style={styles.note}>{t('crisis.foundHere.none')}</Text>
        ) : result.total > result.shown.length ? (
          <Text style={styles.note}>{t('crisis.foundHere.more', { shown: result.shown.length, total: result.total })}</Text>
        ) : null}

        <FlatList<OtherPupil>
          data={result.shown}
          keyExtractor={(pupil) => pupil.studentId}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          renderItem={({ item }) => {
            const name = pupilName(item) || t('common.noValue');
            return (
              <TouchableOpacity
                style={styles.row}
                onPress={() => call && onPick(call, item)}
                disabled={!call}
                accessibilityRole="button"
                accessibilityLabel={t('crisis.foundHere.pickA11y', { name, group: call ? callTitle(call, t) : '' })}
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
