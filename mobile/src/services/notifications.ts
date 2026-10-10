import { getSupabase } from './supabase';
import type { NotificationRow } from '../types';

/**
 * The signed-in person's own in-app notices, for every role's Notiser tab.
 *
 * RLS is not enough to make the inbox the reader's own: a SCHOOL_ADMIN's
 * notifications_admin_select (20260713190000) reads every notice of the
 * school, so without the recipient in the query an admin's inbox listed
 * guardians' absence notices and other staff's cover bookings, worded "Du
 * vikarierar" as if addressed to the admin, and "mark all read" (own rows
 * only under RLS) could never clear the count.
 */
export async function fetchNotifications(userId: string): Promise<NotificationRow[]> {
  const { data, error } = await getSupabase()
    .from('Notifications')
    .select('id, type, meta, readAt, createdAt')
    .eq('userId', userId)
    .order('createdAt', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotificationRow[];
}

/** Every unread notice of the person's own, read now. */
export async function markAllRead(userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('Notifications')
    .update({ readAt: new Date().toISOString() })
    .eq('userId', userId)
    .is('readAt', null);
  if (error) throw new Error(error.message);
}
