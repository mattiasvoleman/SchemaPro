import React, { useCallback } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { DISABLED_OPACITY, type Tone } from '../../theme/tokens';
import { useI18n } from '../../context/LocaleContext';
import { useAcknowledgements } from '../../hooks/useAcknowledgements';
import { formatDateTime } from '../../i18n/format';
import type { Locale } from '../../i18n';
import { useColumnLayout } from '../../layout/responsive';
import { noteOf, waitingCount, type AckMine, type ConfirmOutcome } from '../../services/acknowledgements';

// ─────────────────────────────────────────────────────────────────────────────
// Meddelanden (Kvittens, F4), the guardian's side of "please confirm that you
// have read this". The school asks the guardians of one or more pupils; this
// lists the messages that concern the signed-in guardian's own children,
// newest first, each with one button. After the tap the card says when it was
// confirmed.
//
// What the screen never says: whether the OTHER guardian of a child has
// confirmed. The gateway sends only the signed-in person's own row, and the
// rule is worded as the school's request, not as a count: "all guardians" or
// "one of you is enough".
//
// A confirmation is sent live and never queued (services/acknowledgements.ts):
// a phone with no network is told so, and the button stays.
// ─────────────────────────────────────────────────────────────────────────────

export function AcknowledgementsScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const { gutter } = useColumnLayout();
  const state = useAcknowledgements();
  const { confirm } = state;

  const onConfirm = useCallback(
    async (item: AckMine): Promise<void> => {
      const outcome = await confirm(item.id);
      // Android reads the card's live region when its button turns into the
      // confirmation; iOS has no live regions, so it is told. Not both: a
      // screen reader would say it twice.
      if (outcome?.kind === 'CONFIRMED' && Platform.OS === 'ios') {
        AccessibilityInfo.announceForAccessibility(t('acks.confirmedAnnounce', { title: item.title }));
      }
    },
    [confirm, t],
  );

  if (state.isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const waiting = waitingCount(state.items);
  const failedFirst = state.problem !== null && !state.hasLoaded;
  const stale = state.stale ? noteOf(state.stale, t) : null;

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          {t('acks.title')}
        </Text>
        <Text style={styles.headerSubtitle}>
          {waiting > 0 ? t('acks.subtitleWaiting', { count: waiting }) : t('acks.subtitleNone')}
        </Text>
      </View>

      {state.problem !== null && state.hasLoaded ? (
        <Text
          style={[styles.problem, { paddingHorizontal: gutter, color: state.problem === 'OFFLINE' ? colors.warning : colors.danger }]}
          accessibilityRole="alert"
        >
          {state.problem === 'OFFLINE' ? t('acks.problemOffline') : t('acks.problemFailed')}
        </Text>
      ) : null}

      {/* The message the person tried to confirm has moved on without them.
          It is above the list, not on a card: the card may be gone by now. */}
      {stale ? (
        <View style={{ paddingHorizontal: gutter }}>
          <Note tone={stale.tone} text={stale.text} />
        </View>
      ) : null}

      <FlatList<AckMine>
        data={state.items}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={state.isRefreshing}
            onRefresh={state.refresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        renderItem={({ item }) => (
          <AckCard
            item={item}
            locale={locale}
            sending={state.pending.has(item.id)}
            failure={state.failures[item.id]}
            onConfirm={() => void onConfirm(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>
              {failedFirst ? (state.problem === 'OFFLINE' ? t('acks.offlineTitle') : t('acks.failedTitle')) : t('acks.emptyTitle')}
            </Text>
            <Text style={styles.emptySubtitle}>
              {failedFirst ? (state.problem === 'OFFLINE' ? t('acks.problemOffline') : t('acks.problemFailed')) : t('acks.emptyBody')}
            </Text>
          </View>
        }
        contentContainerStyle={[state.items.length === 0 ? styles.listEmpty : styles.list, { paddingHorizontal: gutter }]}
      />
    </SafeAreaView>
  );
}

function Note({ tone, text }: { readonly tone: Tone; readonly text: string }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={[styles.note, { backgroundColor: colors.toneTint[tone], borderColor: colors[tone] }]} accessibilityLiveRegion="polite">
      <Text style={[styles.noteText, { color: colors[tone] }]}>{text}</Text>
    </View>
  );
}

function AckCard({
  item,
  locale,
  sending,
  failure,
  onConfirm,
}: {
  readonly item: AckMine;
  readonly locale: Locale;
  readonly sending: boolean;
  readonly failure: ConfirmOutcome | undefined;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const note = failure ? noteOf(failure, t) : null;
  const sent = formatDateTime(item.createdAt, locale);
  const confirmedWhen = item.ackedAt === null ? null : formatDateTime(item.ackedAt, locale);

  return (
    <View style={styles.card}>
      <Text style={styles.title} accessibilityRole="header">
        {item.title}
      </Text>
      <Text style={styles.meta}>
        {item.authorName ? t('acks.from', { name: item.authorName, when: sent }) : t('acks.sent', { when: sent })}
      </Text>
      <Text style={styles.body}>{item.body}</Text>
      {item.children.length > 0 ? (
        <Text style={styles.about}>{t('acks.about', { names: item.children.map((child) => child.name).join(', ') })}</Text>
      ) : null}
      {/* The school's request, as the sender made it. Never a word about the other guardian. */}
      <Text style={styles.rule}>{item.rule === 'ALL' ? t('acks.ruleAll') : t('acks.ruleAny')}</Text>
      {note ? <Note tone={note.tone} text={note.text} /> : null}
      {/* Always mounted, so a screen reader that follows live regions says what the button turned into. */}
      <View style={styles.action} accessibilityLiveRegion="polite">
        {confirmedWhen !== null ? (
          <View
            style={styles.confirmed}
            accessible
            accessibilityLabel={t('acks.confirmedA11y', { title: item.title, when: confirmedWhen })}
          >
            <Text style={[styles.confirmedGlyph, { color: colors.success }]} accessibilityElementsHidden importantForAccessibility="no">
              ✓
            </Text>
            <Text style={[styles.confirmedText, { color: colors.success }]}>{t('acks.confirmedAt', { when: confirmedWhen })}</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.button, sending && styles.disabled]}
            onPress={onConfirm}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={t('acks.confirmA11y', { title: item.title })}
            accessibilityState={{ disabled: sending, busy: sending }}
          >
            {sending ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.buttonText}>{t('acks.confirm')}</Text>}
          </TouchableOpacity>
        )}
      </View>
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
  list: { paddingTop: 12, paddingBottom: 24 },
  listEmpty: { flexGrow: 1 },
  card: {
    marginBottom: 10,
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  title: { fontSize: 17, fontWeight: '700', color: c.text },
  meta: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  body: { fontSize: 15, lineHeight: 22, color: c.text, marginTop: 10 },
  about: { fontSize: 13, fontWeight: '600', color: c.text, marginTop: 10 },
  rule: { fontSize: 13, color: c.textMuted, marginTop: 4 },
  note: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  noteText: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  action: { marginTop: 12 },
  button: {
    minHeight: 44,
    backgroundColor: c.primary,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonText: { color: c.onPrimary, fontWeight: '700', textAlign: 'center' },
  disabled: { opacity: DISABLED_OPACITY },
  confirmed: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  confirmedGlyph: { fontSize: 18, fontWeight: '700' },
  confirmedText: { flexShrink: 1, fontSize: 15, fontWeight: '700' },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 8, textAlign: 'center' },
  emptySubtitle: { fontSize: 14, color: c.textMuted, textAlign: 'center', lineHeight: 22 },
}));
