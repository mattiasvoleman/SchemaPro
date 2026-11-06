import React from 'react';
import { Text, View } from 'react-native';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import type { Tone } from '../../theme/tokens';
import { useI18n } from '../../context/LocaleContext';
import type { Translate } from '../../i18n';
import { formatTime } from '../../i18n/format';
import type { CallBasis, CrisisKind, CrisisMode, PupilCounts, PupilStatus } from '../../services/crisis';

/**
 * What the teacher's and the administrator's views of an alarm draw alike
 * (Krisläge, F2): the banner that says what is going on, and the counts.
 *
 * A STATE IS NEVER COLOUR ALONE. A pupil is found, missing, absent since
 * before or not yet marked, and each has its tone, a glyph AND words: a
 * teacher in a schoolyard in low sun, or one who sees no red from green, reads
 * the same list. One meaning per colour, as the rest of the app: green found,
 * red missing, grey absent since before or not in the building (told apart by
 * glyph and words), amber not yet marked.
 */

export const STATUS_TONE: Record<PupilStatus, Tone> = {
  FOUND: 'success',
  MISSING: 'danger',
  // Not in the building is grey, as absent since before is, and told apart from it by its glyph and its words:
  // never green, which would say found, and never red, which would say missing.
  AWAY: 'neutral',
  ABSENT_BEFORE: 'neutral',
  UNREPORTED: 'warning',
};

export const STATUS_GLYPH: Record<PupilStatus, string> = {
  FOUND: '✓',
  MISSING: '✕',
  AWAY: '○',
  ABSENT_BEFORE: '–',
  UNREPORTED: '?',
};

/** The clock on a tap the gateway has not yet taken. */
export const WAITING_GLYPH = '◷';

/**
 * A group in words. The group of an alarm that gathers the pupils who are on no
 * lesson's list (NO_LESSON) comes with a Swedish stand-in for a name, which
 * an English reader must not be handed: it is said in the reader's own language.
 */
export function callTitle(call: { readonly basis: CallBasis; readonly groupName: string; readonly subjectName: string }, t: Translate): string {
  if (call.basis === 'NO_LESSON') return t('crisis.noLesson');
  const subject = call.subjectName || t('common.lesson');
  return call.groupName ? `${call.groupName} · ${subject}` : subject;
}

/** How long ago, in the reader's words: "nyss", "för 12 min sedan", "för 2 tim sedan". */
export function ageText(ms: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t('crisis.age.justNow');
  if (minutes < 120) return t('crisis.age.minutes', { count: minutes });
  return t('crisis.age.hours', { count: Math.floor(minutes / 60) });
}

interface BannerProps {
  /** The phone built the list itself: it does not know the kind of alarm or whether it is a drill. */
  readonly local: boolean;
  readonly kind: CrisisKind | null;
  readonly mode: CrisisMode | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Who started it, for the administration's view. */
  readonly startedBy?: string | null;
}

/**
 * The alarm in one band, in the colour of what it is: red for a real one,
 * amber and the word ÖVNING for a drill, grey and "avslutat" once it is over.
 * A drill is never mistaken for the real thing, and a real alarm is never
 * quiet.
 */
export function AlarmBanner({ local, kind, mode, startedAt, endedAt, startedBy }: BannerProps): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const ended = endedAt !== null;
  const tone: Tone = ended ? 'neutral' : mode === 'DRILL' ? 'warning' : 'danger';
  const what = local || !kind || !mode
    ? t('crisis.bannerLocal')
    : mode === 'DRILL'
      ? t('crisis.bannerDrill', { kind: t(`crisis.kind.${kind}`) })
      : t('crisis.bannerLive', { kind: t(`crisis.kind.${kind}`) });
  const title = ended ? t(mode === 'DRILL' ? 'crisis.endedDrill' : 'crisis.ended') : what;
  const lines = ended
    ? [what, endedAt ? t('crisis.endedAt', { time: formatTime(endedAt) }) : '']
    : [
        startedAt ? (startedBy ? t('crisis.admin.startedBy', { name: startedBy, time: formatTime(startedAt) }) : t('crisis.startedAt', { time: formatTime(startedAt) })) : '',
      ];
  return (
    <View
      style={[styles.banner, { backgroundColor: colors[tone] }]}
      accessible
      accessibilityRole="header"
      accessibilityLiveRegion="polite"
      accessibilityLabel={[title, ...lines].filter((line) => line !== '').join('. ')}
    >
      <Text style={[styles.bannerTitle, { color: colors.onTone }]}>{title}</Text>
      {lines
        .filter((line) => line !== '')
        .map((line) => (
          <Text key={line} style={[styles.bannerLine, { color: colors.onTone }]}>
            {line}
          </Text>
        ))}
    </View>
  );
}

/** The counts of a group or an alarm, each with its glyph and its words; what is nought is not drawn. */
export function CountChips({ counts }: { readonly counts: PupilCounts }): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t } = useI18n();
  const chips: Array<{ status: PupilStatus; text: string; count: number }> = [
    { status: 'FOUND', text: t('crisis.counts.found', { count: counts.found }), count: counts.found },
    { status: 'MISSING', text: t('crisis.counts.missing', { count: counts.missing }), count: counts.missing },
    { status: 'AWAY', text: t('crisis.counts.away', { count: counts.away }), count: counts.away },
    { status: 'ABSENT_BEFORE', text: t('crisis.counts.absentBefore', { count: counts.absentBefore }), count: counts.absentBefore },
    { status: 'UNREPORTED', text: t('crisis.counts.unreported', { count: counts.unreported }), count: counts.unreported },
  ];
  return (
    <View style={styles.chips}>
      {chips
        .filter((chip) => chip.count > 0)
        .map((chip) => (
          <View
            key={chip.status}
            style={[styles.chip, { backgroundColor: colors.toneTint[STATUS_TONE[chip.status]], borderColor: colors[STATUS_TONE[chip.status]] }]}
          >
            <Text style={[styles.chipText, { color: colors[STATUS_TONE[chip.status]] }]}>{`${STATUS_GLYPH[chip.status]} ${chip.text}`}</Text>
          </View>
        ))}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  banner: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, marginTop: 12 },
  bannerTitle: { fontSize: 22, fontWeight: '800', letterSpacing: 0.2 },
  bannerLine: { fontSize: 14, fontWeight: '600', marginTop: 4, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 13, fontWeight: '700' },
}));
