import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TAB_SCREEN_EDGES } from '../tabScreenEdges';
import { makeStyles, useAppTheme } from '../../theme/ThemeContext';
import { fetchNotifications, markAllRead as markOwnRead } from '../../services/notifications';
import { notificationText } from '../../services/notificationText';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../context/LocaleContext';
import { formatDateTime } from '../../i18n/format';
import { useColumnLayout } from '../../layout/responsive';
import type { NotificationRow } from '../../types';

/**
 * In-app notification inbox, the signed-in person's own rows only
 * (services/notifications.ts: an admin's RLS reaches the whole school's), for
 * every role — the tab a push opens. Each row is worded by services/notificationText.ts, all nine
 * types in the reader's language.
 */
export function NotificationsScreen(): React.JSX.Element {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { t, locale } = useI18n();
  const { authState } = useAuth();
  const userId = authState.teacherId;
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRows(userId ? await fetchNotifications(userId) : []);
  }, [userId]);

  useEffect(() => {
    void load()
      .catch(() => undefined)
      .finally(() => setIsLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load().catch(() => undefined);
    setIsRefreshing(false);
  }, [load]);

  const markAllRead = useCallback(async () => {
    if (userId) await markOwnRead(userId).catch(() => undefined);
    await load().catch(() => undefined);
  }, [load, userId]);

  const { gutter } = useColumnLayout();
  const unread = rows.filter((entry) => entry.readAt === null).length;

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={TAB_SCREEN_EDGES}>
      <View style={[styles.header, { paddingHorizontal: gutter }]}>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>{t('notifications.title')}</Text>
          {unread > 0 ? (
            <Text style={styles.headerSubtitle}>{t('notifications.unread', { count: unread })}</Text>
          ) : null}
        </View>
        {unread > 0 ? (
          <TouchableOpacity accessibilityRole="button" onPress={() => void markAllRead()}>
            <Text style={styles.markRead}>{t('notifications.markAllRead')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: gutter }}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />
        }
        renderItem={({ item }) => (
          <View style={[styles.card, item.readAt === null && styles.cardUnread]}>
            <Text style={styles.cardText}>{notificationText(item, t, locale)}</Text>
            <Text style={styles.cardMeta}>{formatDateTime(item.createdAt, locale)}</Text>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>{t('notifications.empty')}</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.background },
  center: { padding: 32, alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerText: { flexShrink: 1 },
  headerTitle: { color: c.text, fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: c.textMuted, fontSize: 13, marginTop: 2 },
  markRead: { color: c.primary, fontWeight: '600' },
  card: {
    backgroundColor: c.surface,
    borderColor: c.borderSubtle,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  cardUnread: { borderColor: c.primary },
  cardText: { color: c.text },
  cardMeta: { color: c.textMuted, fontSize: 12, marginTop: 4 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '700' },
}));
