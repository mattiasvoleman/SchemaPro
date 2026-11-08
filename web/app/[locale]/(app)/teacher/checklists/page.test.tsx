import { screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installApi, renderChecklists, scenario, warmChecklists } from "@/lib/__fixtures__/checklists-render";
import TeacherChecklistsPage from "./page";

/**
 * /teacher/checklists: Checklistor. One heading, the page's subtitle for who is
 * reading, and the tabs; what each tab holds is components/checklists' tests.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => false }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));

beforeAll(() => warmChecklists(), 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  installApi(api, scenario());
});

describe("/teacher/checklists", () => {
  it("has one heading, its subtitle, and the two tabs", async () => {
    renderChecklists(<TeacherChecklistsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Checklistor" })).toBeInTheDocument();
    expect(screen.getByText("Bocka av vilka elever som har fått instruktion, och håll samtyckeslistor för dina mentorsklasser")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Instruktionsbevis" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Samtycken" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Bocka av" });
  });

  it("has no templates: a teacher ticks in them and does not make them", async () => {
    renderChecklists(<TeacherChecklistsPage />);
    await screen.findByRole("region", { name: "Bocka av" });
    expect(screen.queryByRole("region", { name: "Mallar" })).not.toBeInTheDocument();
  });
});
