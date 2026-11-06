import React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles } from '../../theme/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { useColumnLayout } from '../../layout/responsive';
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
// The layout (the gutter that centres the column on a tablet) is read here,
// once, and handed down.
// ─────────────────────────────────────────────────────────────────────────────

export function CrisisScreen(): React.JSX.Element {
  const styles = useStyles();
  const { t } = useI18n();
  const { authState } = useAuth();
  const { gutter } = useColumnLayout();

  if (authState.role === 'TEACHER') return <CrisisTeacherView gutter={gutter} />;
  if (authState.role === 'SCHOOL_ADMIN') return <CrisisAdminView gutter={gutter} />;
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
