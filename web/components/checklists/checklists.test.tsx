import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE, installApi, reads, renderChecklists, scenario, warmChecklists, type Scenario } from "@/lib/__fixtures__/checklists-render";
import { Checklists } from "./checklists";

/**
 * The two tabs of Checklistor: Instruktionsbevis and Samtycken, in an accessible
 * tablist whose choice is kept in the page and not in the address.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => false }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));

let state: Scenario;

beforeAll(() => warmChecklists(), 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  state = scenario();
  installApi(api, state);
});

const tab = (name: string) => screen.getByRole("tab", { name });

describe("the tablist", () => {
  it("has the two tabs, the first selected, and the first panel named by its tab", async () => {
    renderChecklists(<Checklists audience="admin" />);
    expect(screen.getByRole("tablist", { name: "Checklistor" })).toBeInTheDocument();
    expect(tab("Instruktionsbevis")).toHaveAttribute("aria-selected", "true");
    expect(tab("Samtycken")).toHaveAttribute("aria-selected", "false");
    const panel = screen.getByRole("tabpanel", { name: "Instruktionsbevis" });
    expect(tab("Instruktionsbevis")).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toBeVisible();
    // The other panel is not drawn until its tab is opened.
    expect(screen.queryByRole("tabpanel", { name: "Samtycken" })).not.toBeInTheDocument();
    await screen.findByRole("region", { name: "Bocka av" });
  });

  it("has one stop in the tab order: the selected tab", () => {
    renderChecklists(<Checklists audience="admin" />);
    expect(tab("Instruktionsbevis")).toHaveAttribute("tabindex", "0");
    expect(tab("Samtycken")).toHaveAttribute("tabindex", "-1");
  });

  it("opens Samtycken on a click, keeps the first panel in the page hidden, and reads the lists only then", async () => {
    const user = userEvent.setup({ delay: null });
    renderChecklists(<Checklists audience="admin" />);
    await screen.findByRole("region", { name: "Bocka av" });
    expect(reads(api).some((path) => path.includes("/consent-lists"))).toBe(false);
    await user.click(tab("Samtycken"));
    expect(tab("Samtycken")).toHaveAttribute("aria-selected", "true");
    expect(tab("Instruktionsbevis")).toHaveAttribute("aria-selected", "false");
    expect(await screen.findByRole("region", { name: "Samtyckeslistor" })).toBeVisible();
    expect(reads(api)).toContain(`${BASE}/consent-lists`);
    // The first panel is hidden, not gone: a roster being worked on is still there.
    expect(screen.queryByRole("tabpanel", { name: "Instruktionsbevis" })).not.toBeInTheDocument();
    const first = document.getElementById("checklists-panel-instructions")!;
    expect(first).toHaveAttribute("hidden");
    expect(first).not.toBeVisible();
  });

  it("brings the roster back as it was left, without reading it again", async () => {
    const user = userEvent.setup({ delay: null });
    renderChecklists(<Checklists audience="admin" />);
    await user.selectOptions(await screen.findByLabelText("Mall"), "t-1");
    await user.selectOptions(screen.getByLabelText("Grupp"), "g-7a");
    const table = await screen.findByRole("table", { name: /Eleverna i/ });
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    await user.click(tab("Samtycken"));
    await screen.findByRole("region", { name: "Samtyckeslistor" });
    await user.click(tab("Instruktionsbevis"));
    expect(screen.getByLabelText("Mall")).toHaveValue("t-1");
    expect(within(await screen.findByRole("table", { name: /Eleverna i/ })).getByRole("checkbox", { name: "Välj Bo Ek" })).toBeChecked();
    expect(reads(api).filter((path) => path.includes("/roster"))).toHaveLength(1);
  });

  it("moves between the tabs with the arrows, Home and End, and takes focus with the choice", async () => {
    const user = userEvent.setup({ delay: null });
    renderChecklists(<Checklists audience="admin" />);
    await screen.findByRole("region", { name: "Bocka av" });
    tab("Instruktionsbevis").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Samtycken")).toHaveAttribute("aria-selected", "true");
    expect(tab("Samtycken")).toHaveFocus();
    expect(tab("Samtycken")).toHaveAttribute("tabindex", "0");
    await user.keyboard("{ArrowRight}");
    expect(tab("Instruktionsbevis")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("Samtycken")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tab("Instruktionsbevis")).toHaveFocus();
    await user.keyboard("{End}");
    expect(tab("Samtycken")).toHaveFocus();
    // A key that is not the tablist's does nothing.
    await user.keyboard("a");
    expect(tab("Samtycken")).toHaveAttribute("aria-selected", "true");
  });

  it("gives an administrator the templates and a teacher not", async () => {
    renderChecklists(<Checklists audience="teacher" />);
    await screen.findByRole("region", { name: "Bocka av" });
    expect(screen.queryByRole("region", { name: "Mallar" })).not.toBeInTheDocument();
    await waitFor(() => expect(reads(api)).toContain(`${BASE}/groups`));
  });
});
