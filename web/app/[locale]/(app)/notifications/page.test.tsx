import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optOutOf, withChoice, type NotificationPreference } from "@/lib/notification-preferences-queries";
import NotificationSettingsPage from "./page";

/**
 * "Notiser": each person's own choice of what leaves SchemaPro. Under test:
 * the page shows the role's list as the gateway sends it, a required type is
 * on and cannot be switched, a switch sends the WHOLE set back as the gateway
 * replaces it, and staff read LESSON_SUBSTITUTE as "substitutes on my lessons"
 * with the promise that their own cover bookings always arrive. What may be
 * chosen, and by whom, is the gateway's (test/notification-preferences.e2e-spec.ts).
 */

const state = vi.hoisted(() => ({
  role: "GUARDIAN",
  types: [] as NotificationPreference[],
  puts: [] as unknown[],
  /** When set, a PUT waits for it: a save in flight. */
  hold: null as Promise<void> | null,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    get: async () => ({ types: state.types }),
    put: async (_path: string, body: { optOut: string[] }) => {
      state.puts.push(body);
      if (state.hold) await state.hold;
      return { types: state.types.map((entry) => ({ ...entry, enabled: entry.required || !body.optOut.includes(entry.type) })) };
    },
  },
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-1", role: state.role }, school: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

const family: NotificationPreference[] = [
  { type: "LESSON_CANCELLED", enabled: true, required: false },
  { type: "LESSON_SUBSTITUTE", enabled: false, required: false },
  { type: "ABSENCE_UNREPORTED", enabled: true, required: true },
];
const staff: NotificationPreference[] = [
  { type: "LESSON_SUBSTITUTE", enabled: true, required: false },
  { type: "LESSON_COVER_WITHDRAWN", enabled: true, required: true },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.role = "GUARDIAN";
  state.types = family;
  state.puts = [];
  state.hold = null;
});

describe("the choice of what leaves SchemaPro", () => {
  it("shows the guardian's list, with the unreported absence on and not switchable", async () => {
    renderPage();
    const absence = await screen.findByRole("switch", { name: "notificationSettings.types.ABSENCE_UNREPORTED" });
    expect(absence).toBeChecked();
    expect(absence).toBeDisabled();
    expect(screen.getByText("notificationSettings.requiredAbsence")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "notificationSettings.types.LESSON_SUBSTITUTE" })).not.toBeChecked();
  });

  it("sends the whole set back when one switch changes, never a required type", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("switch", { name: "notificationSettings.types.LESSON_CANCELLED" }));
    await waitFor(() => expect(state.puts).toEqual([{ optOut: ["LESSON_CANCELLED", "LESSON_SUBSTITUTE"] }]));
  });

  it("names LESSON_SUBSTITUTE as substitutes on my lessons for staff, and the withdrawal as always sent", async () => {
    state.role = "TEACHER";
    state.types = staff;
    renderPage();
    expect(await screen.findByRole("switch", { name: "notificationSettings.types.LESSON_SUBSTITUTE_STAFF" })).toBeEnabled();
    expect(screen.getByText("notificationSettings.substituteStaffHint")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "notificationSettings.types.LESSON_COVER_WITHDRAWN" })).toBeDisabled();
    expect(screen.getByText("notificationSettings.requiredCover")).toBeInTheDocument();
  });

  it("keeps keyboard focus on a switch while its save is in flight, and takes no second choice meanwhile", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    renderPage();
    const cancelled = await screen.findByRole("switch", { name: "notificationSettings.types.LESSON_CANCELLED" });
    const substitute = screen.getByRole("switch", { name: "notificationSettings.types.LESSON_SUBSTITUTE" });
    cancelled.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(state.puts).toHaveLength(1));
    // A disabled control drops the browser's focus to <body>; these stay focusable.
    expect(cancelled).toBeEnabled();
    expect(substitute).toBeEnabled();
    expect(cancelled).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(cancelled);
    await user.click(substitute);
    expect(state.puts).toHaveLength(1);
    release();
    await waitFor(() => expect(cancelled).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("says so when the role has nothing to choose", async () => {
    state.types = [];
    renderPage();
    expect(await screen.findByText("notificationSettings.empty")).toBeInTheDocument();
  });
});

describe("optOutOf and withChoice", () => {
  it("never names a required type, even one somehow switched off", () => {
    expect(optOutOf([{ type: "ABSENCE_UNREPORTED", enabled: false, required: true }])).toEqual([]);
  });

  it("changes only the type asked about, and leaves a required one alone", () => {
    expect(withChoice(family, "ABSENCE_UNREPORTED", false)).toEqual(family);
    expect(withChoice(family, "LESSON_SUBSTITUTE", true).map((entry) => entry.enabled)).toEqual([true, true, true]);
  });
});
