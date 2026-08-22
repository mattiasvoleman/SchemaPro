import { getSupabase } from './supabase';

/**
 * Everyone who is actually in the room, which is not the same as the class.
 *
 * A home class holds its pupils through Users.studentGroupId, but a teaching
 * group — Ma71, språkval En74 — holds none by construction: its roster lives in
 * StudentGroupMembers. Asking only the first question returned nothing for
 * every nivågrupp, so a teacher opening such a lesson to take attendance met an
 * empty list and could not report at all. The web view was given the full union
 * and this one was not; it is the same union, kept deliberately in the same
 * shape as web/lib/queries.ts useLessonRoster so the two can be read together.
 *
 * Four sources: the lesson's own class, any extra classes attending it,
 * teaching-group membership for all of those, and pupils named individually.
 */
export async function fetchRoster(
  calendarLessonId: string,
  primaryGroupId: string,
): Promise<Array<{ id: string; firstName: string; lastName: string }>> {
  const supabase = getSupabase();
  const [extraGroups, participants] = await Promise.all([
    supabase
      .from('CalendarLessonGroups')
      .select('studentGroupId')
      .eq('calendarLessonId', calendarLessonId),
    supabase
      .from('CalendarLessonStudents')
      .select('studentId')
      .eq('calendarLessonId', calendarLessonId),
  ]);
  if (extraGroups.error) throw new Error(extraGroups.error.message);
  if (participants.error) throw new Error(participants.error.message);

  const groupIds = [
    primaryGroupId,
    ...(extraGroups.data ?? []).map((entry) => entry.studentGroupId as string),
  ];

  const memberships = await supabase
    .from('StudentGroupMembers')
    .select('studentId')
    .in('studentGroupId', groupIds);
  if (memberships.error) throw new Error(memberships.error.message);

  const studentIds = [
    ...new Set([
      ...(participants.data ?? []).map((entry) => entry.studentId as string),
      ...(memberships.data ?? []).map((entry) => entry.studentId as string),
    ]),
  ];

  const filters = [`studentGroupId.in.(${groupIds.join(',')})`];
  if (studentIds.length > 0) filters.push(`id.in.(${studentIds.join(',')})`);

  const { data, error } = await supabase
    .from('Users')
    .select('id, firstName, lastName')
    .eq('role', 'STUDENT')
    .eq('isActive', true)
    .or(filters.join(','))
    .order('lastName');
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; firstName: string; lastName: string }>;
}
