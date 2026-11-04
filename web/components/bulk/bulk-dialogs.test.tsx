import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { BulkResult } from "@/lib/bulk-api";
import { BulkDeleteDialog, BulkEditDialog, BulkSelectField, RefusalList, type DeleteLines } from "./bulk-dialogs";

// Echo the key and its values, so assertions read against stable text.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && Object.keys(values).length > 0 ? `${key}(${Object.values(values).join("|")})` : key,
}));

const NAMES: Record<string, string> = { a: "7A", b: "7B", c: "Ma71" };
const nameOf = (id: string) => NAMES[id] ?? "?";

type Counts = { halves: number };
const describeCounts = (counts: Counts): DeleteLines => ({
  goes: counts.halves > 0 ? [`${counts.halves} halvklasser`] : [],
  loses: [],
  notes: ["note"],
  exhaustive: true,
});

/** The refusal list's line for a row, by the row's name. */
const refusalLine = (name: string) =>
  screen
    .getAllByRole("listitem")
    .map((item) => item.textContent)
    .find((text) => text?.startsWith(`${name}:`));

const report = (overrides: Partial<BulkResult<Counts>>): BulkResult<Counts> => ({
  applied: false,
  dryRun: true,
  done: [],
  refused: [],
  ...overrides,
});

describe("RefusalList", () => {
  it("names each refused row, in the reader's language where the code is known and the gateway's sentence otherwise", () => {
    render(
      <RefusalList
        nameOf={nameOf}
        refused={[
          { id: "a", code: "BULK_ROW_NOT_FOUND", message: "Raden finns inte längre." },
          { id: "b", code: "USER_HAS_BOOKED_PASS_COVERS", message: "…", params: { date: "2026-11-04" } },
          { id: "c", code: null, message: "Läsåret har redan en grupp som heter Ma71." },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([
      "7A: refusal.BULK_ROW_NOT_FOUND",
      "7B: refusal.USER_HAS_BOOKED_PASS_COVERS(2026-11-04)",
      "Ma71: Läsåret har redan en grupp som heter Ma71.",
    ]);
  });
});

describe("BulkDeleteDialog", () => {
  const open = (remove: (body: { ids: string[]; dryRun?: boolean }) => Promise<BulkResult<Counts>>) => {
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    render(
      <BulkDeleteDialog
        entity="groups"
        ids={["a", "b", "c"]}
        nameOf={nameOf}
        remove={remove}
        describe={describeCounts}
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );
    return { onDeleted, onClose };
  };

  it("asks with a dry run as it opens, and says what goes, what goes with it and what does not, before anything is deleted", async () => {
    const remove = vi.fn().mockResolvedValueOnce(
      report({
        done: ["a", "c"],
        refused: [{ id: "b", code: "BULK_ROW_NOT_FOUND", message: "x" }],
        consequences: { halves: 2 },
      }),
    );
    open(remove);
    expect(screen.getByText("deleteChecking")).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "deleteTitle(groups|3)" });
    await within(dialog).findByText("goesTitle(groups|2)", { selector: "h3" });
    expect(remove).toHaveBeenCalledWith({ ids: ["a", "b", "c"], dryRun: true });
    expect(within(dialog).getByRole("list", { name: "goesTitle(groups|2)" })).toHaveTextContent("7AMa71");
    expect(within(dialog).getByText("2 halvklasser")).toBeInTheDocument();
    expect(within(dialog).getByText("note")).toBeInTheDocument();
    expect(within(dialog).getByText("refusedDelete(1)")).toBeInTheDocument();
    expect(refusalLine("7B")).toBe("7B: refusal.BULK_ROW_NOT_FOUND");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("deletes exactly the rows the dry run said would go, and says how many went", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a", "c"], refused: [{ id: "b", code: null, message: "Nej." }], consequences: { halves: 0 } }))
      .mockResolvedValueOnce(report({ applied: true, dryRun: false, done: ["a", "c"] }));
    const { onDeleted } = open(remove);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "deleteOthers(2)" }));
    // With the dry run's counts, which the gateway counts again before it deletes.
    expect(remove).toHaveBeenLastCalledWith({ ids: ["a", "c"], dryRun: false, expected: { halves: 0 } });
    expect(onDeleted).toHaveBeenCalledWith(2);
  });

  it("says nothing else depends on the rows when nothing does", async () => {
    open(vi.fn().mockResolvedValueOnce(report({ done: ["a", "b", "c"], consequences: { halves: 0 } })));
    expect(await screen.findByText("nothingElse")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "deleteCount(3)" })).toBeInTheDocument();
  });

  it("deletes nothing when the real call meets a refusal the dry run did not, lists it with the delete's reason, and asks the rest afresh", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a", "b", "c"], consequences: { halves: 0 } }))
      .mockResolvedValueOnce(report({ dryRun: false, done: ["a", "c"], refused: [{ id: "b", code: "BULK_ROW_REFERENCE_GONE", message: "x" }] }))
      .mockResolvedValueOnce(report({ done: ["a", "c"], consequences: { halves: 1 } }));
    const { onDeleted } = open(remove);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "deleteCount(3)" }));
    expect(await screen.findByText("changedMeanwhile")).toBeInTheDocument();
    // The dry run deletes nothing and could not foresee it: the row is not
    // asked again, and stays listed with the reason the delete gave.
    expect(remove.mock.calls.map((call) => call[0])).toEqual([
      { ids: ["a", "b", "c"], dryRun: true },
      { ids: ["a", "b", "c"], dryRun: false, expected: { halves: 0 } },
      { ids: ["a", "c"], dryRun: true },
    ]);
    expect(refusalLine("7B")).toBe("7B: refusal.BULK_ROW_REFERENCE_GONE");
    expect(screen.getByText("1 halvklasser")).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "deleteOthers(2)" })).toBeInTheDocument();
  });

  it("remembers every round's refusals: a row the first delete refused is neither asked again nor offered after the second", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a", "b", "c"], consequences: { halves: 0 } }))
      .mockResolvedValueOnce(report({ dryRun: false, done: ["a", "c"], refused: [{ id: "b", code: "BULK_ROW_REFERENCE_GONE", message: "x" }] }))
      .mockResolvedValueOnce(report({ done: ["a", "c"], consequences: { halves: 0 } }))
      .mockResolvedValueOnce(report({ dryRun: false, done: ["a"], refused: [{ id: "c", code: "BULK_ROW_TAKEN", message: "y" }] }))
      .mockResolvedValueOnce(report({ done: ["a"], consequences: { halves: 0 } }));
    const { onDeleted } = open(remove);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "deleteCount(3)" }));
    await user.click(await screen.findByRole("button", { name: "deleteOthers(2)" }));
    expect(await screen.findByRole("button", { name: "deleteOthers(1)" })).toBeInTheDocument();
    // The second round's dry run asks only the row neither delete refused;
    // the first round's row stays out of it as the second's does.
    expect(remove.mock.calls.map((call) => call[0])).toEqual([
      { ids: ["a", "b", "c"], dryRun: true },
      { ids: ["a", "b", "c"], dryRun: false, expected: { halves: 0 } },
      { ids: ["a", "c"], dryRun: true },
      { ids: ["a", "c"], dryRun: false, expected: { halves: 0 } },
      { ids: ["a"], dryRun: true },
    ]);
    expect(refusalLine("7B")).toBe("7B: refusal.BULK_ROW_REFERENCE_GONE");
    expect(refusalLine("Ma71")).toBe("Ma71: refusal.BULK_ROW_TAKEN");
    expect(within(screen.getByRole("list", { name: "goesTitle(groups|1)" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["7A"]);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("asks no dry run when the delete refused every row, and offers nothing to delete", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a"], consequences: { halves: 0 } }))
      .mockResolvedValueOnce(report({ dryRun: false, done: [], refused: [{ id: "a", code: "BULK_ROW_NOT_FOUND", message: "x" }] }));
    render(
      <BulkDeleteDialog entity="groups" ids={["a"]} nameOf={nameOf} remove={remove} describe={describeCounts} onClose={vi.fn()} onDeleted={vi.fn()} />,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "deleteCount(1)" }));
    expect(await screen.findByText("nothingToDelete")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(refusalLine("7A")).toBe("7A: refusal.BULK_ROW_NOT_FOUND");
  });

  it("says a delete that ran out of time in the reader's language, and keeps the list to try again", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a", "b", "c"], consequences: { halves: 0 } }))
      .mockRejectedValueOnce(new ApiError(409, "Det tog för lång tid.", "BULK_TIMED_OUT"));
    open(remove);
    await userEvent.setup().click(await screen.findByRole("button", { name: "deleteCount(3)" }));
    expect(await screen.findByText("refusal.BULK_TIMED_OUT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "deleteCount(3)" })).toBeEnabled();
  });

  it("says a delete that found the server busy in the reader's language, and keeps the list to try again", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a", "b", "c"], consequences: { halves: 0 } }))
      .mockRejectedValueOnce(new ApiError(503, "Servern är upptagen just nu.", "BULK_BUSY"));
    open(remove);
    await userEvent.setup().click(await screen.findByRole("button", { name: "deleteCount(3)" }));
    expect(await screen.findByText("refusal.BULK_BUSY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "deleteCount(3)" })).toBeEnabled();
  });

  it("deletes nothing when what goes with the rows grew since the check, and shows the new counts to be confirmed again", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a"], consequences: { halves: 1 } }))
      .mockResolvedValueOnce(
        report({ dryRun: false, done: ["a"], consequences: { halves: 2 }, consequencesGrew: ["halves"] }),
      )
      .mockResolvedValueOnce(report({ applied: true, dryRun: false, done: ["a"] }));
    const { onDeleted } = open(remove);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "deleteCount(1)" }));
    expect(await screen.findByText("changedMeanwhile")).toBeInTheDocument();
    expect(screen.getByText("2 halvklasser")).toBeInTheDocument();
    // The new counts came with the refusal: no new dry run is asked.
    expect(remove).toHaveBeenCalledTimes(2);
    expect(onDeleted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "deleteCount(1)" }));
    expect(remove).toHaveBeenLastCalledWith({ ids: ["a"], dryRun: false, expected: { halves: 2 } });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(1));
  });

  it("never says nothing else depends on the rows when the list is not all there is", async () => {
    render(
      <BulkDeleteDialog
        entity="students"
        ids={["a"]}
        nameOf={nameOf}
        remove={vi.fn().mockResolvedValueOnce(report({ done: ["a"], consequences: { halves: 0 } }))}
        describe={() => ({ goes: [], loses: [], notes: [], exhaustive: false })}
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );
    expect(await screen.findByRole("button", { name: "deleteCount(1)" })).toBeInTheDocument();
    expect(screen.queryByText("nothingElse")).not.toBeInTheDocument();
  });

  it("shows no list and no delete after a check that failed, only the way to ask again", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce(report({ done: ["a", "b"], consequences: { halves: 0 } }))
      .mockResolvedValueOnce(report({ dryRun: false, done: ["a"], refused: [{ id: "b", code: "BULK_ROW_NOT_FOUND", message: "x" }] }))
      .mockRejectedValueOnce(new Error("HTTP 500"));
    open(remove);
    await userEvent.setup().click(await screen.findByRole("button", { name: "deleteCount(2)" }));
    expect(await screen.findByText("deleteCheckFailed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /goesTitle/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });

  it("offers no delete when nothing of the selection can go", async () => {
    open(
      vi.fn().mockResolvedValueOnce(
        report({ refused: ["a", "b", "c"].map((id) => ({ id, code: "NOT_A_STUDENT", message: "x" })) }),
      ),
    );
    expect(await screen.findByText("nothingToDelete")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete/ })).not.toBeInTheDocument();
    // The dialog's own X and the footer's Stäng: nothing but leaving.
    expect(screen.getAllByRole("button", { name: "close" })).toHaveLength(2);
  });

  it("says when the dry run fails, deletes nothing, and asks again on Försök igen", async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValueOnce(report({ done: ["a"], consequences: { halves: 0 } }));
    open(remove);
    expect(await screen.findByText("deleteCheckFailed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "retry" }));
    expect(await screen.findByRole("button", { name: "deleteCount(1)" })).toBeInTheDocument();
  });
});

describe("BulkSelectField", () => {
  const OPTIONS = [
    { value: "__none__", label: "Ingen årskurs" },
    { value: "7", label: "Åk 7" },
    { value: "8", label: "Åk 8" },
  ];

  function Field({ shared, onValue }: { shared: string | null; onValue: (value: string | null) => void }) {
    const [value, setValue] = useState<string | null>(null);
    return (
      <BulkSelectField
        id="grade"
        label="Årskurs"
        options={OPTIONS}
        shared={shared}
        value={value}
        count={4}
        onChange={(next) => {
          setValue(next);
          onValue(next);
        }}
      />
    );
  }

  it("shows Olika värden while the rows differ, and leaves the field until a value is chosen", async () => {
    const onValue = vi.fn();
    const user = userEvent.setup();
    render(<Field shared={null} onValue={onValue} />);
    const select = screen.getByRole("combobox", { name: "Årskurs" });
    expect(select).toHaveTextContent("mixed");
    expect(select).toHaveAccessibleDescription("fieldMixed");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Åk 8" }));
    expect(onValue).toHaveBeenLastCalledWith("8");
    expect(select).toHaveAccessibleDescription("fieldSets(4)");
    // Olika värden again leaves the field as each row has it.
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "mixed" }));
    expect(onValue).toHaveBeenLastCalledWith(null);
  });

  it("shows the value every row has, and choosing it again changes nothing", async () => {
    const onValue = vi.fn();
    const user = userEvent.setup();
    render(<Field shared="7" onValue={onValue} />);
    const select = screen.getByRole("combobox", { name: "Årskurs" });
    expect(select).toHaveTextContent("Åk 7");
    expect(screen.queryByRole("option", { name: "mixed" })).not.toBeInTheDocument();
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Ingen årskurs" }));
    expect(onValue).toHaveBeenLastCalledWith("__none__");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Åk 7" }));
    expect(onValue).toHaveBeenLastCalledWith(null);
  });
});

describe("BulkEditDialog", () => {
  const open = (
    update: (body: { ids: string[]; changes: { gradeLevel: number } }) => Promise<BulkResult<never>>,
    changes: { gradeLevel: number } | null = { gradeLevel: 8 },
  ) => {
    const onSaved = vi.fn();
    render(
      <BulkEditDialog
        entity="groups"
        ids={["a", "b", "c"]}
        nameOf={nameOf}
        update={update}
        changes={changes}
        onClose={() => undefined}
        onSaved={onSaved}
      >
        <p>fields</p>
      </BulkEditDialog>,
    );
    return { onSaved };
  };

  it("saves nothing until a field is changed", () => {
    open(vi.fn(), null);
    expect(screen.getByRole("dialog", { name: "editTitle(groups|3)" })).toHaveTextContent("fields");
    expect(screen.getByRole("button", { name: "saveCount(3)" })).toBeDisabled();
  });

  it("saves the changed fields on every ticked row", async () => {
    const update = vi.fn().mockResolvedValue({ applied: true, dryRun: false, done: ["a", "b", "c"], refused: [] });
    const { onSaved } = open(update);
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(3)" }));
    expect(update).toHaveBeenCalledWith({ ids: ["a", "b", "c"], changes: { gradeLevel: 8 }, dryRun: false });
    expect(onSaved).toHaveBeenCalledWith(3);
  });

  it("when a row refuses, saves nothing, names it and why, and saves the others on request", async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({
        applied: false,
        dryRun: false,
        done: ["a", "c"],
        refused: [{ id: "b", code: "REPLACING_GROUP_NOT_A_TEACHING_GROUP", message: "x" }],
      })
      .mockResolvedValueOnce({ applied: true, dryRun: false, done: ["a", "c"], refused: [] });
    const { onSaved } = open(update);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "saveCount(3)" }));
    expect(await screen.findByText("refusedEdit(1)")).toBeInTheDocument();
    expect(refusalLine("7B")).toBe("7B: refusal.REPLACING_GROUP_NOT_A_TEACHING_GROUP");
    expect(screen.getByText("nothingSavedOthers(2)")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "saveOthers(2)" }));
    expect(update).toHaveBeenLastCalledWith({ ids: ["a", "c"], changes: { gradeLevel: 8 }, dryRun: false });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(2));
  });

  it("offers no save when every row refuses", async () => {
    open(
      vi.fn().mockResolvedValueOnce({
        applied: false,
        dryRun: false,
        done: [],
        refused: ["a", "b", "c"].map((id) => ({ id, code: null, message: "Nej." })),
      }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(3)" }));
    expect(await screen.findByText("nothingSaved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save/ })).not.toBeInTheDocument();
  });

  it("says a refusal the gateway gives a known code in the reader's language", async () => {
    open(vi.fn().mockRejectedValueOnce(new ApiError(400, "A pupil's home class must be a class.", "STUDENT_HOME_GROUP_NOT_A_CLASS")));
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(3)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("refusal.STUDENT_HOME_GROUP_NOT_A_CLASS");
  });

  it("says why a call failed, and keeps the dialog", async () => {
    open(vi.fn().mockRejectedValueOnce(new Error("replacesSubjectId: ämnet finns inte i skolan.")));
    await userEvent.setup().click(screen.getByRole("button", { name: "saveCount(3)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ämnet finns inte i skolan");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
