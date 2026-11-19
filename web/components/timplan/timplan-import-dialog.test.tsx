import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GradeSpan } from "@/lib/timplan-coverage";
import { TimplanImportDialog } from "./timplan-import-dialog";

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock("@/lib/timplan-queries", () => ({
  useImportTimplan: () => ({ mutateAsync, isPending: false }),
}));
// The school's saved column templates: none here (a failed read is "no templates").
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${String(value)}`).join("|")})` : key,
}));

const SPAN_4_9: GradeSpan = { gradeFrom: 4, gradeTo: 9 };

function renderDialog(span: GradeSpan | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TimplanImportDialog open onOpenChange={() => {}} plan={{ id: "p1", name: "Plan", status: "DRAFT", span }} />
    </QueryClientProvider>,
  );
}

async function choose(span: GradeSpan | null, ...lines: string[]) {
  const user = userEvent.setup();
  renderDialog(span);
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

describe("the columns of the file are pointed out before anything is read (Kolumnmappning)", () => {
  it("reads a file with the importer's own headers as it always did, with the column list folded away", async () => {
    await choose(null, "MA;4;236");
    expect(await screen.findByText("rowsReady(count=1)")).toBeInTheDocument();
    expect(screen.getByText("compact.allPlaced(placed=3|total=3)").closest("details")).not.toHaveAttribute("open");
  });

  it("names a column nothing places, waits for the user to point it out, and then sends the post as the mapper reads it", async () => {
    mutateAsync.mockResolvedValue({ created: 1, updated: 0, skipped: 0, errors: [] });
    const user = userEvent.setup();
    renderDialog();
    const file = new File(["Kurs;åk;Minuter\r\nMA;4;236\r\n"], "plan.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("chooseFile"), file);

    // "Kurs" is not a spelling the importer takes, and "Minuter" is not "minuter_per_vecka": Rastra does not guess.
    await screen.findByText(/^unplaced\(count=/);
    expect(screen.getByRole("button", { name: "import" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "columns.fieldOf(column=Kurs)" }), "subject");
    await user.selectOptions(screen.getByRole("combobox", { name: "columns.fieldOf(column=Minuter)" }), "minutesPerWeek");

    await screen.findByText("rowsReady(count=1)");
    await waitFor(() => expect(screen.getByRole("button", { name: "import" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "import" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({ localTimplanId: "p1", rows: [{ subject: "MA", gradeLevel: 4, minutesPerWeek: 236 }] });
  });

  it("reads a pasted table", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByLabelText("pasteLabel"));
    await user.paste("amne\tarskurs\tminuter_per_vecka\nMA\t4\t236\n");
    await user.click(screen.getByRole("button", { name: "pasteRead" }));
    expect(await screen.findByText("rowsReady(count=1)")).toBeInTheDocument();
  });

  it("offers no paste box for a plan that is decided, as it offers no file", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <TimplanImportDialog open onOpenChange={() => {}} plan={{ id: "p1", name: "Plan", status: "DECIDED", span: null }} />
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText("pasteLabel")).not.toBeInTheDocument();
    expect(screen.getByLabelText("chooseFile")).toBeDisabled();
  });
});
