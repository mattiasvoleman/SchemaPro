"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { sortByName } from "@/lib/sorting";
import { createClient } from "@/utils/supabase/client";
import {
  CHECKLISTS_BASE,
  type ConsentAsked,
  type ConsentClosed,
  type ConsentDetail,
  type ConsentListItem,
  type ConsentWritten,
  type GroupChoice,
  type Instructor,
  type ProofRoster,
  type ProofsWritten,
  type ProofVoided,
  type PupilCard,
  type SubjectChoice,
  type TemplateView,
} from "@/lib/checklists";

// ---------------------------------------------------------------------------
// Checklistor: the instruction proofs and the consent lists, through the
// gateway (/api/v1/checklists). Not PostgREST: the gateway answers per role
// from the database's row security (a teacher's groups, a teacher's mentees),
// and records the reads that name pupils (a roster, a list, a pupil's card) in
// the läslogg.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them. The subjects the template form offers are therefore read here, as the
// small PostgREST read they are (they name no one), and not through its
// useSubjects.
//
// Plain useQuery and useMutation, no useInfiniteQuery: a cost on every route's
// shared react-query chunk (see ack-queries.ts), and none of these lists is
// paged: a school has some templates, a class some lists, a list a class.
//
// What a read that names pupils is: read when it is opened and not kept
// (gcTime 0), since the gateway records each reading and a list of pupils is
// not something to leave in the cache of a page that no longer shows it.
// ---------------------------------------------------------------------------

const ROOT = ["checklists"] as const;
export const CHECKLIST_KEYS = {
  all: ROOT,
  templates: [...ROOT, "templates"] as const,
  groups: [...ROOT, "groups"] as const,
  instructors: [...ROOT, "instructors"] as const,
  subjects: [...ROOT, "subjects"] as const,
  roster: [...ROOT, "roster"] as const,
  rosterOf: (templateId: string, groupId: string) => [...ROOT, "roster", templateId, groupId] as const,
  card: [...ROOT, "card"] as const,
  cardOf: (studentId: string) => [...ROOT, "card", studentId] as const,
  lists: [...ROOT, "lists"] as const,
  listsOf: (classId: string, includeClosed: boolean) => [...ROOT, "lists", classId, includeClosed] as const,
  detail: [...ROOT, "detail"] as const,
  detailOf: (id: string) => [...ROOT, "detail", id] as const,
};

const BASE = CHECKLISTS_BASE;

/** The school's templates; the retired ones too for the administrator who restores them. */
export function useTemplates(includeRetired: boolean) {
  return useQuery({
    queryKey: [...CHECKLIST_KEYS.templates, includeRetired],
    retry: false,
    queryFn: () => api.get<TemplateView[]>(`${BASE}/templates${includeRetired ? "?includeRetired=true" : ""}`),
  });
}

/** The groups the reader can look at the proofs of: for a teacher their lessons' groups and their mentees' classes. */
export function useChecklistGroups() {
  return useQuery({
    queryKey: CHECKLIST_KEYS.groups,
    retry: false,
    queryFn: () => api.get<GroupChoice[]>(`${BASE}/groups`),
  });
}

/** The staff who can have given an instruction. Read when the form that offers them is open. */
export function useInstructors(enabled: boolean) {
  return useQuery({
    queryKey: CHECKLIST_KEYS.instructors,
    retry: false,
    enabled,
    queryFn: () => api.get<Instructor[]>(`${BASE}/instructors`),
  });
}

/** The school's subjects, for the template form (the administrator's): a PostgREST read, in Swedish order. */
export function useSubjectChoices(enabled: boolean) {
  return useQuery({
    queryKey: CHECKLIST_KEYS.subjects,
    retry: false,
    enabled,
    queryFn: async (): Promise<SubjectChoice[]> => {
      const { data, error } = await createClient().from("Subjects").select("id, name").order("name").order("id");
      if (error) throw new Error(error.message);
      return sortByName((data ?? []) as SubjectChoice[], (subject) => subject.name);
    },
  });
}

/** A group's pupils and what they have had in a template. Recorded in the läslogg, so read when shown and not kept. */
export function useRoster(templateId: string, groupId: string) {
  return useQuery({
    queryKey: CHECKLIST_KEYS.rosterOf(templateId, groupId),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    enabled: templateId !== "" && groupId !== "",
    queryFn: () => api.get<ProofRoster>(`${BASE}/templates/${templateId}/roster?groupId=${encodeURIComponent(groupId)}`),
  });
}

/** One pupil's card: every tick and where they stand on each list. Recorded in the läslogg, so not kept. */
export function usePupilCard(studentId: string) {
  return useQuery({
    queryKey: CHECKLIST_KEYS.cardOf(studentId),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<PupilCard>(`${BASE}/students/${studentId}`),
  });
}

/** The consent lists, newest first, with counts and no names. The ended ones when asked for. */
export function useConsentLists(classId: string, includeClosed: boolean) {
  const params = new URLSearchParams();
  if (classId) params.set("classId", classId);
  if (includeClosed) params.set("includeClosed", "true");
  const query = params.toString();
  return useQuery({
    queryKey: CHECKLIST_KEYS.listsOf(classId, includeClosed),
    retry: false,
    queryFn: () => api.get<ConsentListItem[]>(`${BASE}/consent-lists${query ? `?${query}` : ""}`),
  });
}

/** One list with where each pupil stands. Recorded in the läslogg, so read when opened and not kept. */
export function useConsentDetail(id: string) {
  return useQuery({
    queryKey: CHECKLIST_KEYS.detailOf(id),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<ConsentDetail>(`${BASE}/consent-lists/${id}`),
  });
}

export function useChecklistActions() {
  const queryClient = useQueryClient();
  const again = (...keys: ReadonlyArray<readonly unknown[]>) => {
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };

  const createTemplate = useMutation({
    mutationFn: (body: { title: string; description?: string; subjectId?: string }) => api.post<TemplateView>(`${BASE}/templates`, body),
    onSuccess: () => again(CHECKLIST_KEYS.templates),
  });
  const updateTemplate = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { title?: string; description?: string | null; subjectId?: string | null; active?: boolean } }) =>
      api.patch<TemplateView>(`${BASE}/templates/${id}`, patch),
    // A roster carries its template, so it is read again with the list.
    onSuccess: () => again(CHECKLIST_KEYS.templates, CHECKLIST_KEYS.roster),
    // A 404 says the template is gone: the list on screen is stale.
    onError: () => again(CHECKLIST_KEYS.templates),
  });
  const tick = useMutation({
    mutationFn: (body: { templateId: string; studentIds: string[]; instructedOn?: string; instructorId?: string; note?: string }) =>
      api.post<ProofsWritten>(`${BASE}/proofs`, body),
    onSuccess: () => again(CHECKLIST_KEYS.roster, CHECKLIST_KEYS.card),
    // 409 says the template was retired, 403 that the roster is not the reader's any more: both say the screen is stale.
    onError: () => again(CHECKLIST_KEYS.templates, CHECKLIST_KEYS.roster),
  });
  const voidProof = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<ProofVoided>(`${BASE}/proofs/${id}/void`, { reason }),
    onSettled: () => again(CHECKLIST_KEYS.roster, CHECKLIST_KEYS.card),
  });
  const createList = useMutation({
    mutationFn: (body: { classId: string; title: string; body: string }) => api.post<ConsentListItem>(`${BASE}/consent-lists`, body),
    onSuccess: () => again(CHECKLIST_KEYS.lists),
  });
  const record = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { studentIds: string[]; kind: string; givenOn?: string; givenBy?: string; note?: string } }) =>
      api.post<ConsentWritten>(`${BASE}/consent-lists/${id}/entries`, body),
    onSuccess: (_written, { id }) => again(CHECKLIST_KEYS.detailOf(id), CHECKLIST_KEYS.lists, CHECKLIST_KEYS.card),
    // 409 says the list was ended, 403 that a pupil is not the reader's: the list on screen is stale.
    onError: (_error, { id }) => again(CHECKLIST_KEYS.detailOf(id)),
  });
  const ask = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { studentIds?: string[] } }) =>
      api.post<ConsentAsked>(`${BASE}/consent-lists/${id}/ask`, body),
    onSuccess: (_asked, { id }) => again(CHECKLIST_KEYS.detailOf(id), CHECKLIST_KEYS.lists),
    // 409 ACK_DISABLED says the switch moved, and CONSENT_LIST_CLOSED that the list was ended.
    onError: (_error, { id }) => again(CHECKLIST_KEYS.detailOf(id)),
  });
  const close = useMutation({
    mutationFn: (id: string) => api.post<ConsentClosed>(`${BASE}/consent-lists/${id}/close`),
    onSettled: (_closed, _error, id) => again(CHECKLIST_KEYS.detailOf(id), CHECKLIST_KEYS.lists),
  });
  return { createTemplate, updateTemplate, tick, voidProof, createList, record, ask, close };
}
