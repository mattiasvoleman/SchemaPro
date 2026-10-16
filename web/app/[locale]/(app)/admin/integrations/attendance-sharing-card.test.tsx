import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import { AttendanceSharingCard } from "./attendance-sharing-card";
import { KeysTab } from "./keys-tab";
import type { AttendanceSharing } from "./ss12000-types";

/**
 * Närvaro och frånvaro till integrationer over the real hooks and the real
 * Swedish messages: what the school is told before it decides, that a
 * decision is confirmed before it is sent and is sent as a new one (shares
 * flipped, the reference if any), and that the decisions before it stay in
 * view with who made them.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// The signed-in administrator's profile (Roller i skolan): full unless a test says otherwise.
const me = vi.hoisted(() => ({ profile: { adminProfile: "FULL" as string | undefined } }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => me }));

function renderCard(answer: AttendanceSharing) {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/integrations/attendance-sharing") return answer;
    throw new Error(`unexpected ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <AttendanceSharingCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("AttendanceSharingCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    me.profile.adminProfile = "FULL";
  });

  it("is rektor's decision: a profile that does not decide reads it and is told who does, with nothing to press", async () => {
    me.profile.adminProfile = "SCHEMALAGGARE";
    renderCard({
      current: { shares: true, reference: null, decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" },
      history: [{ shares: true, reference: null, decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" }],
    });
    expect(await screen.findByText("Delas")).toBeInTheDocument();
    expect(screen.getByText("Beslutet fattas av rektor eller en fullständig administratör.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sluta dela" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Diarienummer eller underlag/)).not.toBeInTheDocument();
    // Rektor gets them.
    me.profile.adminProfile = "REKTOR";
    renderCard({ current: null, history: [] });
    expect(await screen.findByRole("button", { name: "Börja dela" })).toBeInTheDocument();
  });

  it("says nothing is shared without a decision, and what would and never would leave", async () => {
    renderCard({ current: null, history: [] });
    expect(await screen.findByText("Delas inte")).toBeInTheDocument();
    expect(screen.getByText(/Skolan har inte fattat något beslut/)).toBeInTheDocument();
    expect(screen.getByText(/Lämnas ut: minuter närvaro och frånvaro per lektion/)).toBeInTheDocument();
    expect(screen.getByText(/Lämnas aldrig ut: orsaken till frånvaron/)).toBeInTheDocument();
    expect(screen.getByText(/läsloggen/)).toBeInTheDocument();
    expect(screen.queryByText("Tidigare beslut")).not.toBeInTheDocument();
  });

  it("asks before it shares, and sends a new decision with the reference", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ shares: true, reference: "Dnr 2026:41", decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" });
    renderCard({ current: null, history: [] });
    await user.type(await screen.findByLabelText(/Diarienummer eller underlag/), "  Dnr 2026:41 ");
    await user.click(screen.getByRole("button", { name: "Börja dela" }));
    expect(post).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Dela närvaro och frånvaro med integrationer?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Börja dela" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/integrations/attendance-sharing", { shares: true, reference: "Dnr 2026:41" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Skolan delar nu närvaro och frånvaro med integrationer.");
  });

  it("shows the decision in force with who made it, offers to stop, and keeps the earlier ones", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ shares: false, reference: null, decidedAt: "2026-11-20T08:00:00.000Z", decidedBy: "Rolf Rektor" });
    renderCard({
      current: { shares: true, reference: "Dnr 2026:41", decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" },
      history: [
        { shares: true, reference: "Dnr 2026:41", decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" },
        { shares: false, reference: null, decidedAt: "2026-11-01T08:00:00.000Z", decidedBy: null },
      ],
    });
    expect(await screen.findByText("Delas")).toBeInTheDocument();
    expect(screen.getByText(/av Rolf Rektor/)).toBeInTheDocument();
    expect(screen.getByText("Diarienummer eller underlag: Dnr 2026:41")).toBeInTheDocument();
    expect(screen.getByText("Tidigare beslut")).toBeInTheDocument();
    // A decider whose account is gone is named as the other histories name them.
    expect(screen.getByText(/delas inte \(Borttagen användare\)$/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sluta dela" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Sluta dela" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/integrations/attendance-sharing", { shares: false }));
    // The answer is in force at once: the card offers the next decision, not the same one again.
    expect(await screen.findByRole("button", { name: "Börja dela" })).toBeInTheDocument();
    expect(screen.getByText("Delas inte")).toBeInTheDocument();
  });
});

describe("the attendance scopes in the scope picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver ??= class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  function renderKeys(answer: AttendanceSharing) {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/integrations/attendance-sharing") return answer;
      if (path === "/api/v1/integration-keys/provider") return [];
      throw new Error(`unexpected ${path}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
          <KeysTab />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  }

  it("tells each attendance scope's checkbox that the school does not share, while it does not", async () => {
    renderKeys({ current: null, history: [] });
    const box = await screen.findByRole("checkbox", { name: "attendances.read" });
    await waitFor(() => expect(box).toHaveAccessibleDescription(/kan inte läsa något förrän skolan har beslutat det/));
    expect(screen.getByRole("checkbox", { name: "absences.read" })).toHaveAccessibleDescription(/kan inte läsa något/);
    expect(screen.getByRole("checkbox", { name: "persons.read" })).not.toHaveAccessibleDescription(/kan inte läsa något/);
  });

  it("says nothing more once the school shares", async () => {
    renderKeys({
      current: { shares: true, reference: null, decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" },
      history: [{ shares: true, reference: null, decidedAt: "2026-11-14T08:00:00.000Z", decidedBy: "Rolf Rektor" }],
    });
    expect(await screen.findByText("Delas")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "attendances.read" })).not.toHaveAccessibleDescription(/kan inte läsa något/);
    expect(screen.queryByText(/kan inte läsa något/)).not.toBeInTheDocument();
  });
});
