import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupRemovalConsequences } from "@/lib/bulk-api";
import type { StudentGroup } from "@/lib/types";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { GROUP_BELOW_PARENTS, GROUP_BULK_KEYS, GroupsBulkDialogs, describeGroupRemoval } from "./groups-bulk-dialogs";

// Echo the key and its values, so assertions read against stable text.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && Object.keys(values).length > 0 ? `${key}(${Object.values(values).join("|")})` : key,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The calls the dialogs make, and what each list told the hook. */
const calls = vi.hoisted(() => ({
  base: "",
  keys: [] as unknown,
  remove: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/bulk-api", () => ({
  useBulkActions: (base: string, keys: unknown) => {
    calls.base = base;
    calls.keys = keys;
    return { remove: { mutateAsync: calls.remove }, update: { mutateAsync: calls.update } };
  },
}));

const group = (id: string, name: string, overrides: Partial<StudentGroup> = {}): StudentGroup =>
  ({
    id,
    academicYearId: "year-1",
    name,
    kind: "CLASS",
    gradeLevel: 7,
    halfOfId: null,
    predecessorId: null,
    replacesSubjectId: null,
    ...overrides,
  }) as StudentGroup;

const G7A = group("g-7a", "7A");
const G7B = group("g-7b", "7B", { gradeLevel: 8 });
const HALF = group("g-7a1", "7A:1", { kind: "TEACHING_GROUP", halfOfId: "g-7a" });
const SVA7 = group("g-sva7", "SvA7", { kind: "TEACHING_GROUP", gradeLevel: null, replacesSubjectId: "s-sv" });
const SVA8 = group("g-sva8", "SvA8", { kind: "TEACHING_GROUP", gradeLevel: null });
const GROUPS = [G7A, G7B, HALF, SVA7, SVA8];
const SUBJECTS = [
  { id: "s-sv", name: "Svenska" },
  { id: "s-en", name: "Engelska" },
] as never[];

const open = (mode: "edit" | "delete", ids: string[]) => {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  render(
    <GroupsBulkDialogs mode={mode} ids={ids} groups={GROUPS} subjects={SUBJECTS} onClose={onClose} onDeleted={onDeleted} />,
  );
  return { onClose, onDeleted };
};

const choose = async (field: string, option: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
};

describe("describeGroupRemoval", () => {
  const t = (key: string, values: Record<string, number>) => `${key}(${values.count})`;
  const none = {
    halves: 0,
    homePupils: 0,
    successors: 0,
    memberships: 0,
    requirements: 0,
    masterLessons: 0,
    sharedLessons: 0,
    calendarLessons: 0,
    attendanceMarks: 0,
    lessonLogs: 0,
    availabilityConstraints: 0,
    lunchSittings: 0,
    calendarBreaks: 0,
    timplanCredits: 0,
    publicLinks: 0,
    enrolments: 0,
    mentorDuties: 0,
    consentLists: 0,
    fromSource: 0,
  };

  it("says what goes with the groups and what is left without them, and nothing for a count of 0", () => {
    expect(
      describeGroupRemoval(t, {
        ...none,
        halves: 2,
        requirements: 9,
        attendanceMarks: 120,
        publicLinks: 1,
        homePupils: 20,
        enrolments: 20,
        successors: 1,
      }),
    ).toEqual({
      goes: [
        "groupConsequences.halves(2)",
        "groupConsequences.requirements(9)",
        "groupConsequences.attendanceMarks(120)",
        "groupConsequences.publicLinks(1)",
        // The requirements' shared teacher time, said without a number.
        "groupConsequences.below(undefined)",
      ],
      loses: ["groupConsequences.homePupils(20)", "groupConsequences.enrolments(20)", "groupConsequences.successors(1)"],
      notes: [],
      exhaustive: true,
    });
  });

  it("says when groups come from the SS12000 source, which may add them again", () => {
    expect(describeGroupRemoval(t, { ...none, fromSource: 3 }).notes).toEqual(["fromSource(3)"]);
  });

  /*
   * The gateway's kinds reach the dialog through the messages: its spec
   * (src/common/removal-inventory.spec.ts) holds every kind a dry run answers
   * to a line in bulk.groupConsequences, and these hold every line there to
   * the dialog. A kind counted but not listed would make the list say
   * "nothing else" with rows going unsaid.
   */
  const kinds = Object.keys(sv.bulk.groupConsequences).filter((key) => key !== "below");

  it.each([
    ["sv", sv],
    ["en", en],
  ])("has the same lines in %s", (_locale, messages) => {
    expect(Object.keys(messages.bulk.groupConsequences).sort()).toEqual(Object.keys(sv.bulk.groupConsequences).sort());
  });

  it.each(kinds)("says %s whenever it is counted", (kind) => {
    const shown = describeGroupRemoval(t, { ...none, [kind]: 2 } as GroupRemovalConsequences);
    expect([...shown.goes, ...shown.loses]).toContain(`groupConsequences.${kind}(2)`);
  });

  it.each(GROUP_BELOW_PARENTS)("says what hangs a level down whenever %s is counted, without a number", (kind) => {
    expect(describeGroupRemoval(t, { ...none, [kind]: 1 }).goes).toContain("groupConsequences.below(undefined)");
  });

  it("says nothing of a level down when no row with rows below it goes", () => {
    const others = Object.fromEntries(kinds.filter((kind) => !(GROUP_BELOW_PARENTS as readonly string[]).includes(kind)).map((kind) => [kind, 1]));
    expect(describeGroupRemoval(t, { ...none, ...others }).goes).not.toContain("groupConsequences.below(undefined)");
  });
});

describe("GroupsBulkDialogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes through the groups' bulk routes and makes their lists stale", () => {
    open("edit", ["g-7a"]);
    expect(calls.base).toBe("/api/v1/student-groups");
    expect(calls.keys).toBe(GROUP_BULK_KEYS);
    expect(GROUP_BULK_KEYS).toEqual(
      expect.arrayContaining([["groups"], ["people"], ["requirements"], ["masterLessons"], ["calendarLessons"]]),
    );
  });

  it("shows Olika värden for an årskurs the classes differ in, and sets the one chosen on all of them", async () => {
    calls.update.mockResolvedValue({ applied: true, dryRun: false, done: ["g-7a", "g-7b"], refused: [] });
    const { onClose } = open("edit", ["g-7a", "g-7b"]);
    expect(screen.getByRole("combobox", { name: "groupFields.gradeLevel" })).toHaveTextContent("mixed");
    await choose("groupFields.gradeLevel", "gradeShort(9)");
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(2)" }));
    expect(calls.update).toHaveBeenCalledWith({ ids: ["g-7a", "g-7b"], changes: { gradeLevel: 9 }, dryRun: false });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("saved(2)");
  });

  it("clears the årskurs with Ingen årskurs, sent as null", async () => {
    calls.update.mockResolvedValue({ applied: true, dryRun: false, done: ["g-7a"], refused: [] });
    open("edit", ["g-7a"]);
    expect(screen.getByRole("combobox", { name: "groupFields.gradeLevel" })).toHaveTextContent("gradeShort(7)");
    await choose("groupFields.gradeLevel", "groupFields.gradeNone");
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(1)" }));
    expect(calls.update).toHaveBeenCalledWith({ ids: ["g-7a"], changes: { gradeLevel: null }, dryRun: false });
  });

  it("offers Ersätter ämne only when every ticked group may replace one: a class or a half in the selection says why not", () => {
    open("edit", ["g-7a", "g-sva8"]);
    expect(screen.queryByRole("combobox", { name: "groupFields.replaces" })).not.toBeInTheDocument();
    expect(screen.getByText("groupFields.replacesUnavailable")).toBeInTheDocument();
  });

  it("sets Ersätter ämne on teaching groups, and leaves the årskurs alone", async () => {
    calls.update.mockResolvedValue({ applied: true, dryRun: false, done: ["g-sva7", "g-sva8"], refused: [] });
    open("edit", ["g-sva7", "g-sva8"]);
    expect(screen.getByRole("combobox", { name: "groupFields.replaces" })).toHaveTextContent("mixed");
    await choose("groupFields.replaces", "Svenska");
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(2)" }));
    expect(calls.update).toHaveBeenCalledWith({ ids: ["g-sva7", "g-sva8"], changes: { replacesSubjectId: "s-sv" }, dryRun: false });
  });

  it("asks the delete's dry run of the ticked groups, names them, and thanks with a count", async () => {
    calls.remove
      .mockResolvedValueOnce({
        applied: false,
        dryRun: true,
        done: ["g-7a", "g-7a1"],
        refused: [],
        consequences: {
          halves: 1, homePupils: 20, successors: 0, memberships: 0, requirements: 9, masterLessons: 0, sharedLessons: 0,
          calendarLessons: 0, attendanceMarks: 0, lessonLogs: 0, availabilityConstraints: 0, lunchSittings: 0,
          calendarBreaks: 0, timplanCredits: 0, publicLinks: 0, enrolments: 20, mentorDuties: 0, consentLists: 0, fromSource: 0,
        },
      })
      .mockResolvedValueOnce({ applied: true, dryRun: false, done: ["g-7a", "g-7a1"], refused: [] });
    const { onDeleted } = open("delete", ["g-7a", "g-7a1"]);
    expect(await screen.findByText("groupConsequences.requirements(9)")).toBeInTheDocument();
    expect(screen.getByText("groupConsequences.homePupils(20)")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "goesTitle(groups|2)" })).toHaveTextContent("7A7A:1");
    await userEvent.setup().click(screen.getByRole("button", { name: "deleteCount(2)" }));
    expect(calls.remove).toHaveBeenLastCalledWith(expect.objectContaining({ ids: ["g-7a", "g-7a1"], dryRun: false }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("deleted(2)");
  });
});
