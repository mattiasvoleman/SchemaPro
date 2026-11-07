import type {
  AckDetail,
  AckGuardianRow,
  AckListItem,
  AckMine,
  AckPage,
  AckPupilChoice,
  AckPupilRow,
  AckSettings,
} from "@/lib/ack";

/*
 * Kvittens's answers as the page tests need them: a few builders over the
 * gateway's shapes (src/ack/ack-views.ts), each filling in what a test does not
 * care about.
 */

export const SETTINGS_ON: AckSettings = { enabled: true, remindAfterDays: 2 };
export const SETTINGS_OFF: AckSettings = { enabled: false, remindAfterDays: 2 };

export const PUPILS: AckPupilChoice[] = [
  { id: "p-ada", name: "Ada Berg", className: "7A", guardians: 2 },
  { id: "p-bo", name: "Bo Ek", className: "7A", guardians: 1 },
  { id: "p-cia", name: "Cia Lund", className: "7B", guardians: 0 },
  { id: "p-dan", name: "Dan Dal", className: "7B", guardians: 2 },
];

/** A page of a list as the gateway answers one: `next` is the id to ask after, or null for the last. */
export const page = <T>(items: T[], next: string | null = null): AckPage<T> => ({ items, next });

export const listItem = (over: Partial<AckListItem> = {}): AckListItem => ({
  id: "r-1",
  title: "Utflykten på torsdag",
  rule: "ANY",
  authorName: "Anna Lind",
  createdAt: "2026-11-05T08:30:00.000Z",
  pupils: 3,
  met: 1,
  waiting: 4,
  remindAt: "2026-11-07T08:30:00.000Z",
  reminder: "SCHEDULED",
  ...over,
});

export const guardian = (id: string, name: string, state: AckGuardianRow["state"], over: Partial<AckGuardianRow> = {}): AckGuardianRow => ({
  id,
  name,
  state,
  ackedAt: state === "CONFIRMED" ? "2026-11-05T09:12:00.000Z" : null,
  remindedAt: null,
  ...over,
});

export const pupilRow = (id: string, name: string, guardians: AckGuardianRow[], over: Partial<AckPupilRow> = {}): AckPupilRow => ({
  id,
  name,
  className: "7A",
  met: guardians.some((one) => one.state === "CONFIRMED"),
  guardians,
  ...over,
});

export const detail = (over: Partial<AckDetail> = {}): AckDetail => ({
  id: "r-1",
  title: "Utflykten på torsdag",
  body: "Vi åker kl 8.\nTa med matsäck.",
  rule: "ANY",
  authorName: "Anna Lind",
  createdAt: "2026-11-05T08:30:00.000Z",
  remindAt: "2026-11-07T08:30:00.000Z",
  reminderSentAt: null,
  reminder: "SCHEDULED",
  mayStopReminder: false,
  pupils: [
    pupilRow("p-ada", "Ada Berg", [guardian("g-sara", "Sara Berg", "CONFIRMED"), guardian("g-tom", "Tom Berg", "WAITING")]),
    pupilRow("p-bo", "Bo Ek", [guardian("g-eva", "Eva Ek", "WAITING")]),
    pupilRow("p-dan", "Dan Dal", [guardian("g-ola", "Ola Dal", "ENDED")], { className: "7B" }),
  ],
  ...over,
});

export const mineItem = (over: Partial<AckMine> = {}): AckMine => ({
  id: "r-1",
  title: "Utflykten på torsdag",
  body: "Vi åker kl 8.\nTa med matsäck.",
  rule: "ANY",
  authorName: "Anna Lind",
  createdAt: "2026-11-05T08:30:00.000Z",
  children: [{ id: "p-ada", name: "Ada Berg" }],
  ackedAt: null,
  ...over,
});
