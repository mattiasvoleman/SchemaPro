import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GradeSpan } from "@/lib/timplan-coverage";
import { TimplanImportDialog } from "./timplan-import-dialog";

vi.mock("@/lib/timplan-queries", () => ({
  useImportTimplan: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${String(value)}`).join("|")})` : key,
}));

const SPAN_4_9: GradeSpan = { gradeFrom: 4, gradeTo: 9 };

async function choose(span: GradeSpan | null, ...lines: string[]) {
  const user = userEvent.setup();
  render(
    <TimplanImportDialog
      open
      onOpenChange={() => {}}
      plan={{ id: "p1", name: "Plan", status: "DRAFT", span }}
    />,
  );
  const file = new File([["amne;arskurs;minuter_per_vecka", ...lines].join("\r\n")], "plan.csv", { type: "text/csv" });
  await user.upload(screen.getByLabelText("chooseFile"), file);
  return screen;
}

describe("the import into a plan with an årskurs span", () => {
  it("says before upload how many rows are for årskurser outside the span, and which", async () => {
    await choose(SPAN_4_9, "MA;1;236", "MA;2;236", "MA;2;60", "MA;5;200", "BL;F;40");
    // The rows are accepted — nothing is an error — and the note names them: F written as F.
    expect(await screen.findByText("importOutsideSpan(count=4|span=spanRange(from=4|to=9)|grades=F, 1, 2)")).toBeInTheDocument();
    expect(screen.queryByText("mappingErrors")).not.toBeInTheDocument();
    expect(screen.getByText("rowsReady(count=5)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "import" })).toBeEnabled();
  });

  it("says nothing when every row is inside the span", async () => {
    await choose(SPAN_4_9, "MA;4;236", "MA;9;200");
    expect(await screen.findByText("rowsReady(count=2)")).toBeInTheDocument();
    expect(screen.queryByText(/importOutsideSpan/)).not.toBeInTheDocument();
  });

  it("says nothing for a plan with no span, where every årskurs is the plan's", async () => {
    await choose(null, "MA;1;236", "MA;2;236");
    expect(await screen.findByText("rowsReady(count=2)")).toBeInTheDocument();
    expect(screen.queryByText(/importOutsideSpan/)).not.toBeInTheDocument();
  });
});
