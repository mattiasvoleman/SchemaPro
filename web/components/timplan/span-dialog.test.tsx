import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GradeSpan } from "@/lib/timplan-coverage";
import { SpanDialog, type SpanDialogProps } from "./span-dialog";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SPAN_7_9: GradeSpan = { gradeFrom: 7, gradeTo: 9 };

function open(props: Partial<SpanDialogProps> & Pick<SpanDialogProps, "plan">) {
  const onConfirm = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(<SpanDialog open onOpenChange={onOpenChange} grades={GRADES} pending={false} onConfirm={onConfirm} {...props} />);
  return { onConfirm, onOpenChange, user: userEvent.setup() };
}

const from = () => screen.getByLabelText("spanFromLabel") as HTMLSelectElement;
const to = () => screen.getByLabelText("spanToLabel") as HTMLSelectElement;
const confirm = () => screen.getByRole("button", { name: "spanConfirm" });
const values = (select: HTMLSelectElement) =>
  within(select).getAllByRole("option").map((option) => (option as HTMLOptionElement).value);

describe("SpanDialog on a draft", () => {
  it("takes any span, and nothing is to save until it is changed", async () => {
    const { user, onConfirm } = open({ plan: { name: "Utkast", status: "DRAFT", span: SPAN_7_9 } });
    expect([from().value, to().value]).toEqual(["7", "9"]);
    expect(confirm()).toBeDisabled();
    await user.selectOptions(from(), "4");
    expect(confirm()).toBeEnabled();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ gradeFrom: 4, gradeTo: 9 });
  });

  it("can give a draft back the whole school form", async () => {
    const { user, onConfirm } = open({ plan: { name: "Utkast", status: "DRAFT", span: SPAN_7_9 } });
    await user.selectOptions(from(), "spanWholeForm");
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("suggests the skolenheternas span for a draft with none, and applies it only when saved", async () => {
    const { user, onConfirm } = open({
      plan: { name: "Utkast", status: "DRAFT", span: null },
      suggestedSpan: SPAN_7_9,
    });
    expect([from().value, to().value]).toEqual(["7", "9"]);
    expect(screen.getByText("spanHintFromUnits")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(SPAN_7_9);
  });

  it("has nothing to save for a draft with no span and no suggestion", () => {
    open({ plan: { name: "Utkast", status: "DRAFT", span: null } });
    expect(from().value).toBe("");
    expect(confirm()).toBeDisabled();
  });
});

describe("SpanDialog on a decided plan", () => {
  it("sets a span once: says so, names who will be recorded, and offers no way back to 'no span'", async () => {
    const { user, onConfirm } = open({ plan: { name: "Beslutad", status: "DECIDED", span: null } });
    expect(screen.getByText("spanDecidedBody(Beslutad)")).toBeInTheDocument();
    expect(screen.getByText("spanDecidedOnce")).toBeInTheDocument();
    // Whole school form is the plan as it is, not a span to set.
    expect(values(from())).not.toContain("spanWholeForm");
    expect(screen.getByRole("option", { name: "spanChoose" })).toBeInTheDocument();
    expect(confirm()).toBeDisabled();

    await user.selectOptions(from(), "7");
    // The end follows the start to the form's last årskurs.
    expect([from().value, to().value]).toEqual(["7", "9"]);
    expect(values(from())).not.toContain("");
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ gradeFrom: 7, gradeTo: 9 });
  });

  it("starts from the skolenheternas span, which still has to be confirmed", async () => {
    const { user, onConfirm } = open({
      plan: { name: "Beslutad", status: "DECIDED", span: null },
      suggestedSpan: SPAN_7_9,
    });
    expect([from().value, to().value]).toEqual(["7", "9"]);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(SPAN_7_9);
  });

  it("offers no edit when the plan already has a span: it says so and points to Öppna igen", () => {
    open({ plan: { name: "Beslutad", status: "DECIDED", span: SPAN_7_9 } });
    expect(screen.getByText("spanLockedBody(Beslutad|spanRange(7|9))")).toBeInTheDocument();
    expect(screen.queryByLabelText("spanFromLabel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "spanConfirm" })).not.toBeInTheDocument();
    // Only a way out: the footer's Stäng beside the corner's.
    expect(screen.getAllByRole("button", { name: "close" })).toHaveLength(2);
  });
});

describe("SpanDialog while saving", () => {
  it("cannot be closed or confirmed twice", async () => {
    const { user, onOpenChange } = open({
      plan: { name: "Utkast", status: "DRAFT", span: SPAN_7_9 },
      pending: true,
    });
    expect(confirm()).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
