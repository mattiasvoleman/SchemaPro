import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LAW_2028, NATIONAL } from "@/lib/__fixtures__/timplan-statute";
import type { SchoolUnit } from "@/lib/school-units";
import type { GradeSpan } from "@/lib/timplan-coverage";
import type { CreatePlanBody } from "@/lib/timplan-queries";
import { CopyDialog, gatewayDraftName } from "./copy-dialog";
import { CreateDialog, defaultVersionFor } from "./create-dialog";
import { DecideDialog } from "./decide-dialog";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

/** A nine-year grundskola's årskurser as the span's selects offer them: F, 1–9. */
const GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SPAN_4_9: GradeSpan = { gradeFrom: 4, gradeTo: 9 };

const unit = (name: string, gradeFrom: number | null, gradeTo: number | null, schoolTypes: SchoolUnit["schoolTypes"] = ["GR"]): SchoolUnit => ({
  id: name,
  name,
  code: null,
  schoolTypes,
  gradeFrom,
  gradeTo,
  fromSource: false,
});

const from = () => screen.getByLabelText("spanFromLabel") as HTMLSelectElement;
const to = () => screen.getByLabelText("spanToLabel") as HTMLSelectElement;

describe("DecideDialog", () => {
  it("will not decide without a note that identifies the decision", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<DecideDialog open onOpenChange={() => {}} planName="Grundskola 2026" pending={false} onConfirm={onConfirm} />);

    expect(screen.getByText("decideBody(Grundskola 2026)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("decisionNoteRequired");

    await user.type(screen.getByLabelText("decisionNoteLabel"), "   ");
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("sends the note trimmed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<DecideDialog open onOpenChange={() => {}} planName="P" pending={false} onConfirm={onConfirm} />);
    await user.type(screen.getByLabelText("decisionNoteLabel"), "  Beslutat av huvudman 2026-05-12, dnr 12  ");
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith("Beslutat av huvudman 2026-05-12, dnr 12");
  });

  it("refuses a note longer than the column takes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<DecideDialog open onOpenChange={() => {}} planName="P" pending={false} onConfirm={onConfirm} />);
    const field = screen.getByLabelText("decisionNoteLabel");
    await user.click(field);
    await user.paste("x".repeat(501));
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("decisionNoteTooLong");
  });
});

describe("CopyDialog", () => {
  it("reopens a decided plan into a draft the admin may name, saying the decided one stays", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="reopen" open onOpenChange={() => {}} planName="Beslutad 2026" spanGrades={GRADES} sourceSpan={null} pending={false} onConfirm={onConfirm} />);
    expect(screen.getByText("reopenBody(Beslutad 2026)")).toBeInTheDocument();
    expect(screen.getByText("copyNameHint(Beslutad 2026 (utkast))")).toBeInTheDocument();
    await user.type(screen.getByLabelText("copyNameLabel"), " Utkast HT2027 ");
    await user.click(screen.getByRole("button", { name: "reopenConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith("Utkast HT2027", undefined);
  });

  it("announces the very name the gateway will give: its Swedish suffix, numbered when taken", () => {
    // The English hint said "P (draft)" and neither locale knew the number,
    // so the toast landed on a draft named otherwise than announced.
    render(
      <CopyDialog
        mode="copy"
        open
        onOpenChange={() => {}}
        planName="P"
        takenNames={["P", "P (kopia)", "P (kopia 2)"]}
        spanGrades={GRADES}
        sourceSpan={null}
        pending={false}
        onConfirm={async () => {}}
      />,
    );
    expect(screen.getByText("copyNameHint(P (kopia 3))")).toBeInTheDocument();
    expect(gatewayDraftName("x".repeat(100), "utkast", [])).toBe(`${"x".repeat(91)} (utkast)`);
    expect(gatewayDraftName("x".repeat(100), "utkast", []).length).toBe(100);
  });

  it("leaves the name to the gateway when the field is empty", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="copy" open onOpenChange={() => {}} planName="P" spanGrades={GRADES} sourceSpan={null} pending={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "copyConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined, undefined);
  });

  it("copies the plan's own span by saying nothing of it, so the gateway copies it", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="copy" open onOpenChange={() => {}} planName="P" spanGrades={GRADES} sourceSpan={SPAN_4_9} suggestedSpan={{ gradeFrom: 7, gradeTo: 9 }} pending={false} onConfirm={onConfirm} />);
    // The plan's own span is what is shown, not the skolenheternas.
    expect([from().value, to().value]).toEqual(["4", "9"]);
    expect(screen.getByText("spanHintSame")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "copyConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined, undefined);
  });

  it("states the span only when it was changed: another span, or the whole form", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="copy" open onOpenChange={() => {}} planName="P" spanGrades={GRADES} sourceSpan={SPAN_4_9} pending={false} onConfirm={onConfirm} />);
    await user.selectOptions(from(), "5");
    await user.click(screen.getByRole("button", { name: "copyConfirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith(undefined, { gradeFrom: 5, gradeTo: 9 });

    await user.selectOptions(from(), "spanWholeForm");
    expect(to()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "copyConfirm" }));
    expect(onConfirm).toHaveBeenLastCalledWith(undefined, null);
  });

  it("gives a plan with no span of its own the skolenheternas on a reopen, where such a plan gets one", async () => {
    // Every plan decided before the span existed has none to copy.
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="reopen" open onOpenChange={() => {}} planName="Beslutad 2026" spanGrades={GRADES} sourceSpan={null} suggestedSpan={{ gradeFrom: 7, gradeTo: 9 }} pending={false} onConfirm={onConfirm} />);
    expect([from().value, to().value]).toEqual(["7", "9"]);
    expect(screen.getByText("spanHintFromUnits")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "reopenConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined, { gradeFrom: 7, gradeTo: 9 });
  });

  it("lets the admin decline the suggestion and keep the whole form", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CopyDialog mode="reopen" open onOpenChange={() => {}} planName="P" spanGrades={GRADES} sourceSpan={null} suggestedSpan={{ gradeFrom: 7, gradeTo: 9 }} pending={false} onConfirm={onConfirm} />);
    await user.selectOptions(from(), "spanWholeForm");
    await user.click(screen.getByRole("button", { name: "reopenConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith(undefined, undefined);
  });
});

describe("CreateDialog", () => {
  it("defaults a grundskola plan to the bilaga in force, not to the unpublished 2028 law", () => {
    expect(defaultVersionFor(NATIONAL.versions, "GRUNDSKOLA")?.code).toBe("SFS2023:945/B1");
    expect(defaultVersionFor(NATIONAL.versions, "SAMESKOLA")?.code).toBe("SFS2023:945/B4");
  });

  it("creates with 35,6 weeks and the form's version, and wants a name", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {});
    render(<CreateDialog open onOpenChange={() => {}} versions={NATIONAL.versions} pending={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "createConfirm" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("nameRequired")).toBeInTheDocument();

    await user.type(screen.getByLabelText("nameLabel"), "Grundskola 2026");
    await user.click(screen.getByRole("button", { name: "createConfirm" }));
    expect(onConfirm).toHaveBeenCalledWith({
      name: "Grundskola 2026",
      schoolForm: "GRUNDSKOLA",
      nationalTimplanVersionId: NATIONAL.versions.find((v) => v.code === "SFS2023:945/B1")!.id,
      planningWeeks: 35.6,
    });
  });

  describe("the årskurs span", () => {
    const create = async (units?: SchoolUnit[]) => {
      const user = userEvent.setup();
      const onConfirm = vi.fn(async (_body: CreatePlanBody) => {});
      render(<CreateDialog open onOpenChange={() => {}} versions={NATIONAL.versions} units={units} pending={false} onConfirm={onConfirm} />);
      await user.type(screen.getByLabelText("nameLabel"), "Plan");
      return { user, onConfirm };
    };

    it("is prefilled with the skolenheternas årskurser and sent with the plan", async () => {
      const { user, onConfirm } = await create([unit("Norra 4–6", 4, 6), unit("Norra 7–9", 7, 9)]);
      expect([from().value, to().value]).toEqual(["4", "9"]);
      expect(screen.getByText("spanHintFromUnits")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ gradeFrom: 4, gradeTo: 9 }));
    });

    it("offers F and 1–9 for a nine-year lydelse", async () => {
      await create([unit("Norra", 4, 9)]);
      expect(within(from()).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", ...GRADES.map(String)]);
    });

    it("has no prefill when no unit holds the plan's skolform, and sends no span", async () => {
      // A school with only an anpassad grundskola unit and a grundskola plan.
      const { user, onConfirm } = await create([unit("Anpassade", 1, 9, ["GRS"])]);
      expect([from().value, to().value]).toEqual(["", ""]);
      expect(screen.getByText("spanHint")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(onConfirm.mock.calls[0]![0]).not.toHaveProperty("gradeFrom");
      expect(onConfirm.mock.calls[0]![0]).not.toHaveProperty("gradeTo");
    });

    it("says the whole form when the units hold every årskurs of it anyway", async () => {
      const { user, onConfirm } = await create([unit("F–9", 0, 9)]);
      expect([from().value, to().value]).toEqual(["", ""]);
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(onConfirm.mock.calls[0]![0]).not.toHaveProperty("gradeFrom");
    });

    it("sends what the fields say after the admin changed them", async () => {
      const { user, onConfirm } = await create([unit("Norra", 4, 9)]);
      await user.selectOptions(to(), "6");
      expect([from().value, to().value]).toEqual(["4", "6"]);
      expect(screen.getByText("spanHint")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ gradeFrom: 4, gradeTo: 6 }));
    });

    it("sends no span when the admin chose the whole form over the skolenheternas", async () => {
      const { user, onConfirm } = await create([unit("Norra", 4, 9)]);
      await user.selectOptions(from(), "spanWholeForm");
      expect(to()).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm.mock.calls[0]![0]).not.toHaveProperty("gradeFrom");
      expect(onConfirm.mock.calls[0]![0]).not.toHaveProperty("gradeTo");
    });

    it("keeps the pair whole and in order: a start past the end moves the end, an end before the start the start", async () => {
      const { user } = await create([unit("Norra", 4, 6)]);
      await user.selectOptions(from(), "8");
      expect([from().value, to().value]).toEqual(["8", "8"]);
      await user.selectOptions(to(), "5");
      expect([from().value, to().value]).toEqual(["5", "5"]);
    });

    it("reads the units in the tioårig numbering for a plan against the 2028 lydelse (4–9 becomes 5–10)", async () => {
      const { user, onConfirm } = await create([unit("Norra", 4, 9)]);
      await user.click(screen.getByRole("combobox", { name: "versionLabel" }));
      await user.click(await screen.findByRole("option", { name: new RegExp(`${LAW_2028.sfs}`) }));
      expect([from().value, to().value]).toEqual(["5", "10"]);
      // 1–10: the tioårig lydelse has no förskoleklass row to offer.
      expect(within(from()).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ nationalTimplanVersionId: LAW_2028.id, gradeFrom: 5, gradeTo: 10 }));
    });
  });
});
