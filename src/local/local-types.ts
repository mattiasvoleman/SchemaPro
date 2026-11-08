/*
 * LOKAL (K3): THE SHAPES THE GATEWAY ANSWERS, AS THE WEB READS THEM.
 *
 * Dates are ISO days (yyyy-mm-dd) in the school's zone, clocks are "HH:MM", and
 * instants are ISO strings. Ids are uuids. No answer here carries a person with a
 * login by id other than the one asking; the contact of an external booking is
 * personal data about somebody who has none, and is in the answers to an
 * administrator alone.
 */

import type { RoomBookingStatus } from '@prisma/client';

export interface ResourceTypeResponse {
  id: string;
  name: string;
  /** How many resources are of the type: the delete guard's number. */
  resources: number;
}

export interface ResourceResponse {
  id: string;
  name: string;
  resourceTypeId: string;
  resourceTypeName: string;
  quantity: number;
  siteId: string | null;
  siteName: string | null;
  place: string | null;
  requiresApproval: boolean;
}

/** A resource, and how many of it nobody holds at any minute of the asked window. */
export interface ResourceAvailabilityResponse extends ResourceResponse {
  free: number;
}

export interface ResourceBookingResponse {
  id: string;
  resourceId: string;
  resourceName: string;
  title: string;
  quantity: number;
  startsAt: string;
  endsAt: string;
  status: RoomBookingStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  /** The booker's name, for an administrator; null for a teacher reading their own. */
  bookedByName: string | null;
  /** The booking is a day of an external hire: it has no booker to name and is not cancelled here. */
  external: boolean;
}

export interface ResourceBookingResult {
  id: string;
  status: RoomBookingStatus;
}

/** Why a day of a series cannot be booked, or may be a problem. */
export type ExternalConflictKind =
  /** A lesson that holds its time uses the room. */
  | 'LESSON'
  /** Another booking holds the room, or the resource's quantity is used. */
  | 'BOOKING'
  /** The day is inside the school's ramtid for the room's years. */
  | 'FRAME'
  /** The room is closed then (a closure on the room). */
  | 'CLOSED'
  /** The room is lent to another school then, or borrowed and not covered by the loan. */
  | 'LOAN'
  /** A schemabrytande aktivitet has a lesson then: the activity may use the room. A warning, not a refusal. */
  | 'ACTIVITY';

export interface ExternalConflict {
  kind: ExternalConflictKind;
  /** BLOCK refuses the day; WARN is told and does not. */
  severity: 'BLOCK' | 'WARN';
  /**
   * The data of the conflict, never prose, so the web says the kind in its own
   * language: the lesson ("Matematik 7A"), the booking's title, the ramtid
   * ("08:00-15:00"), the closure's reason, how many are held ("28 av 30"), the
   * loan's code (ROOM_LENT, ROOM_BORROWED_OUTSIDE_LOAN), the activity's name.
   * May be empty. Names no person.
   */
  label: string;
}

export interface ExternalOccurrencePreview {
  date: string;
  startsAt: string;
  endsAt: string;
  conflicts: ExternalConflict[];
}

export interface ExternalPreviewResponse {
  occurrences: ExternalOccurrencePreview[];
  /** Days in the series. */
  count: number;
  /** Days with at least one BLOCK conflict. */
  blocked: number;
  /** Days with only WARN conflicts. */
  warned: number;
  /** True when the school has declared no ramtider, so FRAME was not asked. */
  framesMissing: boolean;
}

export interface ExternalBookingTarget {
  kind: 'ROOM' | 'RESOURCE';
  id: string;
  name: string;
}

export interface ExternalBookingSummary {
  id: string;
  target: ExternalBookingTarget;
  resourceQuantity: number | null;
  organisation: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  purpose: string | null;
  note: string | null;
  weekdays: number[];
  intervalWeeks: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  cancelledAt: string | null;
  createdAt: string;
  /** The administrator who registered it, by name; null once they are removed. */
  registeredByName: string | null;
  days: {
    /** Days the series made, cancelled or not. */
    total: number;
    /** Active days that have not started. */
    upcoming: number;
    cancelled: number;
    /** Dates left out at registration because something else held them. */
    skipped: string[];
  };
  /** Upcoming active days that now clash with a lesson: the expedition's flag. */
  clashes: number;
}

export interface ExternalDayResponse {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  status: RoomBookingStatus;
  conflicts: ExternalConflict[];
}

export interface ExternalBookingDetail extends ExternalBookingSummary {
  occurrences: ExternalDayResponse[];
}

export interface ExternalBookingResult {
  id: string;
  /** Days written. */
  created: number;
  /** Dates left out (skipConflicts), each with what held it. */
  skipped: Array<{ date: string; conflicts: ExternalConflict[] }>;
}

/** One day of a series that stands in a room that has a lesson: the flag list of the expedition. */
export interface ExternalClashResponse {
  seriesId: string;
  dayId: string;
  organisation: string;
  targetName: string;
  date: string;
  startsAt: string;
  endsAt: string;
  /** The lesson it clashes with, as the schedule names it: "Matematik 7A". */
  lesson: string;
}

export interface UtilisationBucket {
  /** Minutes of school time (inside the ramtid on a teaching day) in the period. */
  schoolMinutes: number;
  bookedSchoolMinutes: number;
  /** bookedSchoolMinutes / schoolMinutes, 0..1; null when there is no school time. */
  schoolShare: number | null;
  /** Minutes of evenings and weekends: the open hours outside school time. */
  outsideMinutes: number;
  bookedOutsideMinutes: number;
  outsideShare: number | null;
}

export interface UtilisationRow {
  kind: 'ROOM' | 'RESOURCE';
  id: string;
  name: string;
  /** What it counts in: minutes for a room, unit-minutes for a resource of more than one. */
  unit: 'MINUTES' | 'UNIT_MINUTES';
  total: UtilisationBucket;
  weeks: Array<{ weekStart: string } & UtilisationBucket>;
}

export interface UtilisationResponse {
  from: string;
  to: string;
  timezone: string;
  /** The open hours the evening and weekend share is measured against, "HH:MM". */
  openFrom: string;
  openTo: string;
  /** True when the school has declared no ramtider: there is no school time to share. */
  framesMissing: boolean;
  /** Mondays of the weeks the period touches, in order. */
  weekStarts: string[];
  rows: UtilisationRow[];
}
