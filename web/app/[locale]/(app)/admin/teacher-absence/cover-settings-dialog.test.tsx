import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import { CoverSettingsDialog } from "./cover-settings-dialog";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

/**
 * The school's settings for absence and cover: self-report (off unless the
 * school turns it on), where the pool ranks, the reason list (built-ins
 * hidden, never renamed), the pool and a member's hours.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const put = api.put as unknown as Mock;
const patch = api.patch as unknown as Mock;
vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [{ id: "t-cia", firstName: "Cia", lastName: "Holm", email: "cia@example.se", phone: "070-1" }],
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TEACHERS = [
  { id: "t-cia", name: "Cia Holm" },
  { id: "t-dan", name: "Dan Ström" },
];

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <CoverSettingsDialog open onOpenChange={() => {}} teachers={TEACHERS} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/cover/settings") return { poolPreference: "NEUTRAL", teacherSelfReport: false };
    if (path === "/api/v1/teacher-absence-reasons") {
      return [
        { id: "r-sick", builtin: "SICK", label: null, sortOrder: 10, archived: false },
        { id: "r-own", builtin: null, label: "Facklig tid", sortOrder: 60, archived: false },
      ];
    }
    if (path === "/api/v1/cover/pool") return [{ userId: "t-cia", createdAt: "2026-10-01T00:00:00Z" }];
    if (path.startsWith("/api/v1/cover/availability")) return [];
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("Frånvaro och vikarier", () => {
  it("turns self-report on and ranks the pool last in one save", async () => {
    put.mockImplementation(async (_path: string, body: unknown) => body);
    const user = userEvent.setup();
    renderDialog();
    const save = await screen.findByRole("button", { name: "Spara reglerna" });
    expect(save).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText("Vikariepoolen i förslagen")).toHaveValue("NEUTRAL"));
    await user.click(screen.getByRole("checkbox", { name: /Lärare får anmäla sin egen frånvaro/ }));
    await user.selectOptions(screen.getByLabelText("Vikariepoolen i förslagen"), "LAST_RESORT");
    await user.click(save);
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/cover/settings", {
        teacherSelfReport: true,
        poolPreference: "LAST_RESORT",
      }),
    );
  });

  it("hides a built-in reason and offers renaming only for the school's own", async () => {
    patch.mockResolvedValue({});
    const user = userEvent.setup();
    renderDialog();
    const sick = (await screen.findByText("Sjukdom")).closest("li")!;
    expect(within(sick).queryByRole("button", { name: "Byt namn" })).not.toBeInTheDocument();
    const own = screen.getByText("Facklig tid").closest("li")!;
    expect(within(own).getByRole("button", { name: "Byt namn" })).toBeInTheDocument();
    await user.click(within(sick).getByRole("button", { name: "Dölj" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/teacher-absence-reasons/r-sick", { archived: true }),
    );
  });

  it("adds a teacher to the pool and shows a member's contact, never a reason", async () => {
    post.mockResolvedValue({ userId: "t-dan" });
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByText("cia@example.se · 070-1")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Lägg till i poolen"), "t-dan");
    await user.click(screen.getByRole("button", { name: "Lägg till" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cover/pool", { userId: "t-dan" }));
  });

  it("adds a weekly window for a member", async () => {
    post.mockResolvedValue({});
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Tider" }));
    expect(await screen.findByText("Inga tider angivna.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Veckodag"), "3");
    await user.click(screen.getByRole("button", { name: "Lägg till tid" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cover/availability", {
        userId: "t-cia",
        dayOfWeek: 3,
        startTime: "08:00",
        endTime: "16:00",
      }),
    );
  });
});
