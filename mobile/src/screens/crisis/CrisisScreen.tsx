import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles } from '../../theme/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useColumnLayout } from '../../layout/responsive';
import { alarmViews, type AlarmView } from '../../services/auth/appGate';
import { CrisisAdminView } from './CrisisAdminView';
import { CrisisTeacherView } from './CrisisTeacherView';

// ─────────────────────────────────────────────────────────────────────────────
// Larm (Krisläge, F2), the tab of an alarm. One route, two readers: a TEACHER
// counts their own groups, found or missing, from a list the phone keeps and
// a queue it sends from when the network allows (CrisisTeacherView); an
// administrator starts the alarm, watches the roll call and ends it
// (CrisisAdminView). The role decides which is mounted, so neither reader's
// hooks run for the other: the gateway answers each only its own routes.
//
// An administrator who teaches (Users.teaches) is both readers. The gateway
// answers both of them, so she has both views: her own groups' roll call is
// what the tab opens on, every time it is shown, and the administration's
// view is a button in its header (and the way back in the other's). An alarm
// is when a teacher is wanted in the room, so the roll call comes first even
// when no alarm is going. Which views a person has, and which is first, is
// appGate.alarmViews; only one view is mounted at a time, so the hooks of
// the one she is not looking at do not run (the roll call's queue is sent by
// the sync context whichever is shown).
//
// The layout (the gutter that centres the column on a tablet) is read here,
// once, and handed down.
// ─────────────────────────────────────────────────────────────────────────────

export function CrisisScreen(): React.JSX.Element {
  const styles = useStyles();
  const { t } = useI18n();
  const { authState } = useAuth();
  const { gutter } = useColumnLayout();
  const views = alarmViews(authState.role, authState.teaches);
  // The view she has moved to, until the tab is shown again: every time Larm is shown it opens on its first view.
  const [chosen, setChosen] = useState<AlarmView | null>(null);
  useFocusEffect(
    useCallback(() => {
      setChosen(null);
    }, []),
  );
  const view = chosen !== null && views.includes(chosen) ? chosen : views[0];
  const both = views.length > 1;

  if (view === 'ROLL_CALL') return <CrisisTeacherView gutter={gutter} toManagement={both ? () => setChosen('MANAGEMENT') : undefined} />;
  if (view === 'MANAGEMENT') return <CrisisAdminView gutter={gutter} toRollCall={both ? () => setChosen('ROLL_CALL') : undefined} />;
  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={styles.center}>
        <Text style={styles.title}>{t('crisis.unavailable')}</Text>
      </View>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 36, paddingVertical: 60 },
  title: { fontSize: 18, fontWeight: '700', color: c.text, textAlign: 'center' },
}));
