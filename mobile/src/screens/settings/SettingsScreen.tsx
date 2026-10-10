import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { LOCALES, translatorFor, type Locale, type MessageKey } from '../../i18n';
import {
  fetchPreferences,
  savePreferences,
  withChoice,
  type NotificationPreference,
} from '../../services/notificationPreferences';
import {
  disablePush,
  enablePush,
  ensureAndroidChannel,
  isPushEnabledFor,
  refreshRegistration,
  serverPushEnabled,
  type PushOutcome,
} from '../../services/pushRegistration';

/**
 * Settings, the same screen for every role: the language, push on this
 * device (offered only when the school's gateway sends push), what may leave
 * SchemaPro as e-mail and push per notice type (the school's required ones
 * shown on and locked), and logging out — which also takes this device off
 * the person's push.
 */

const STAFF = new Set(['TEACHER', 'SCHOOL_ADMIN']);

const PUSH_MESSAGE: Partial<Record<PushOutcome, MessageKey>> = {
  SERVER_OFF: 'settings.pushServerOff',
  DENIED: 'settings.pushDenied',
  UNSUPPORTED: 'settings.pushUnsupported',
  FAILED: 'settings.pushFailed',
};

export function SettingsScreen(): React.JSX.Element {
  const { authState, logout } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const userId = authState.teacherId;
  const staff = STAFF.has(authState.role ?? '');

  const [serverPush, setServerPush] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [pushNote, setPushNote] = useState<MessageKey | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [types, setTypes] = useState<NotificationPreference[] | null>(null);
  const [typesError, setTypesError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const [enabled, mine] = await Promise.all([serverPushEnabled(), isPushEnabledFor(userId)]);
    setServerPush(enabled);
    setPushOn(enabled && mine);
    try {
      setTypes(await fetchPreferences());
      setTypesError(false);
    } catch {
      setTypesError(true);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const chooseLocale = useCallback(
    async (next: Locale) => {
      if (next === locale) return;
      await setLocale(next);
      // The push texts and the Android channel follow the language.
      await ensureAndroidChannel(translatorFor(next)('push.channelName'));
      if (userId) await refreshRegistration(userId, next);
    },
    [locale, setLocale, userId],
  );

  const togglePush = useCallback(
    async (on: boolean) => {
      if (!userId) return;
      setPushBusy(true);
      setPushNote(null);
      try {
        if (on) {
          const outcome = await enablePush(userId, locale);
          setPushOn(outcome === 'ENABLED');
          setPushNote(PUSH_MESSAGE[outcome] ?? null);
        } else {
          await disablePush(userId);
          setPushOn(false);
        }
      } finally {
        setPushBusy(false);
      }
    },
    [userId, locale],
  );

  const chooseType = useCallback(
    async (entry: NotificationPreference, enabled: boolean) => {
      if (!types) return;
      const next = withChoice(types, entry.type, enabled);
      setTypes(next);
      setSaving(true);
      try {
        setTypes(await savePreferences(next));
      } catch {
        setTypes(types);
        Alert.alert(t('settings.title'), t('settings.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [types, t],
  );

  const typeLabel = (entry: NotificationPreference): string =>
    entry.type === 'LESSON_SUBSTITUTE' && staff ? t('settings.types.LESSON_SUBSTITUTE_STAFF') : t(`settings.types.${entry.type}`);
  const typeHint = (entry: NotificationPreference): string | null => {
    if (entry.type === 'ABSENCE_UNREPORTED') return t('settings.requiredAbsence');
    if (entry.type === 'LESSON_COVER_WITHDRAWN') return t('settings.requiredCover');
    if (entry.type === 'LESSON_SUBSTITUTE' && staff) return t('settings.substituteStaffHint');
    return entry.required ? t('settings.required') : null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />}
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{t('settings.title')}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('settings.language')}</Text>
          <View style={styles.chipRow}>
            {LOCALES.map((value) => (
              <TouchableOpacity
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: value === locale }}
                onPress={() => void chooseLocale(value)}
                style={[styles.chip, value === locale && styles.chipActive]}
              >
                <Text style={[styles.chipText, value === locale && styles.chipTextActive]}>
                  {t(value === 'sv' ? 'settings.languageSv' : 'settings.languageEn')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('settings.pushTitle')}</Text>
          <Text style={styles.cardBody}>{t('settings.pushBody')}</Text>
          {serverPush ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t('settings.pushToggle')}</Text>
              {pushBusy ? (
                <ActivityIndicator color="#6366f1" />
              ) : (
                <Switch
                  accessibilityLabel={t('settings.pushToggle')}
                  value={pushOn}
                  onValueChange={(value) => void togglePush(value)}
                />
              )}
            </View>
          ) : (
            <Text style={styles.hint}>{t('settings.pushServerOff')}</Text>
          )}
          {pushNote ? <Text style={styles.hint}>{t(pushNote)}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('settings.typesTitle')}</Text>
          <Text style={styles.cardBody}>{t('settings.typesBody')}</Text>
          {typesError ? (
            <Text style={styles.errorText}>{t('common.loadError')}</Text>
          ) : types === null ? (
            <ActivityIndicator color="#6366f1" />
          ) : types.length === 0 ? (
            <Text style={styles.hint}>{t('settings.typesEmpty')}</Text>
          ) : (
            types.map((entry) => {
              const hint = typeHint(entry);
              return (
                <View key={entry.type} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{typeLabel(entry)}</Text>
                    {hint ? <Text style={styles.hint}>{hint}</Text> : null}
                  </View>
                  <Switch
                    accessibilityLabel={typeLabel(entry)}
                    value={entry.enabled}
                    disabled={entry.required || saving}
                    onValueChange={(value) => void chooseType(entry, value)}
                  />
                </View>
              );
            })
          )}
        </View>

        <TouchableOpacity accessibilityRole="button" style={styles.logout} onPress={() => void logout()}>
          <Text style={styles.logoutText}>{t('settings.logout')}</Text>
        </TouchableOpacity>
        <View style={styles.footerSpace} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  headerTitle: { color: '#e2e8f0', fontSize: 22, fontWeight: '700' },
  card: {
    backgroundColor: '#1a1a2e',
    borderColor: '#2d2d4a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 8,
  },
  cardTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  cardBody: { color: '#94a3b8', fontSize: 13 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderColor: '#2d2d4a', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipActive: { backgroundColor: '#6366f1', borderColor: '#6366f1' },
  chipText: { color: '#94a3b8', fontSize: 13 },
  chipTextActive: { color: '#ffffff', fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
  rowText: { flexShrink: 1 },
  rowLabel: { color: '#e2e8f0', flexShrink: 1 },
  hint: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  errorText: { color: '#f87171' },
  logout: {
    marginHorizontal: 16,
    marginTop: 8,
    borderColor: '#f87171',
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 12,
  },
  logoutText: { color: '#f87171', fontWeight: '700' },
  footerSpace: { height: 32 },
});
