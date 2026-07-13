import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  SafeAreaView,
} from 'react-native';
import { getSupabase } from '../../services/supabase';
import type { NotificationRow } from '../../types';

function renderText(entry: NotificationRow): string {
  const meta = entry.meta ?? {};
  const str = (key: string): string => String(meta[key] ?? '');
  switch (entry.type) {
    case 'ABSENCE_UNREPORTED':
      return `${str('studentName')} was marked absent from ${str('subjectName')} on ${str('date')} without a prior report.`;
    case 'LEAVE_DECIDED':
      return `Leave for ${str('studentName')} (${str('startDate')} – ${str('endDate')}) was ${
        str('status') === 'APPROVED' ? 'approved' : 'rejected'
      }.`;
    case 'LESSON_CANCELLED':
      return `${str('subjectName')} on ${new Date(str('startsAt')).toLocaleString()} was cancelled.`;
    case 'LESSON_SUBSTITUTE':
      return `${str('subjectName')} on ${new Date(str('startsAt')).toLocaleString()} has a substitute teacher.`;
    case 'SCHEDULE_CHANGED':
      return `The weekly schedule for ${str('subjectName')} was changed.`;
    default:
      return 'Notification';
  }
}

async function fetchNotifications(): Promise<NotificationRow[]> {
  const { data, error } = await getSupabase()
    .from('Notifications')
    .select('id, type, meta, readAt, createdAt')
    .order('createdAt', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotificationRow[];
}

/** In-app notification inbox (RLS: own rows only). */
export function NotificationsScreen(): React.JSX.Element {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRows(await fetchNotifications());
  }, []);

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
    await getSupabase()
      .from('Notifications')
      .update({ readAt: new Date().toISOString() })
      .is('readAt', null);
    await load().catch(() => undefined);
  }, [load]);

  const unread = rows.filter((entry) => entry.readAt === null).length;

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Notifications</Text>
          {unread > 0 ? <Text style={styles.headerSubtitle}>{unread} unread</Text> : null}
        </View>
        {unread > 0 ? (
          <TouchableOpacity accessibilityRole="button" onPress={() => void markAllRead()}>
            <Text style={styles.markRead}>Mark all read</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#6366f1" />
        }
        renderItem={({ item }) => (
          <View style={[styles.card, item.readAt === null && styles.cardUnread]}>
            <Text style={styles.cardText}>{renderText(item)}</Text>
            <Text style={styles.cardMeta}>{new Date(item.createdAt).toLocaleString()}</Text>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No notifications yet</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f1a' },
  center: { padding: 32, alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: { color: '#e2e8f0', fontSize: 22, fontWeight: '700' },
  headerSubtitle: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  markRead: { color: '#6366f1', fontWeight: '600' },
  card: {
    backgroundColor: '#1a1a2e',
    borderColor: '#1e1e3a',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  cardUnread: { borderColor: '#6366f1' },
  cardText: { color: '#e2e8f0' },
  cardMeta: { color: '#64748b', fontSize: 12, marginTop: 4 },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
});
