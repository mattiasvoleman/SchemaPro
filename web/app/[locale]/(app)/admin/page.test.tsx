import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import AdminDashboardPage from "./page";

/**
 * The admin dashboard's figures, rendered as the server renders them. Pupils,
 * teachers and the week's attendance are counted by the gateway since the
 * läslogg: an admin's PostgREST reads no other person's Users or
 * AttendanceRecords row, so a count there would read 0 for a school of 400.
 * The tables the läslogg does not cover are still counted through PostgREST.
 * A figure that could not be read is "—" and the notice, never a 0.
 */

type Answer = { data: unknown } | { error: string };

const state = vi.hoisted(() => ({
  people: { data: null } as Answer,
  attendance: { data: null } as Answer,
}));
const serverApiGet = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok-1" } } }) },
    from,
  }),
}));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ school: { name: "Testskolan" } }) }));
vi.mock("@/lib/server-api", () => ({ serverApiGet }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/layout/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "sv",
  getTranslations: async () => (key: string) => (sv.dashboard as Record<string, string>)[key] ?? key,
}));

/** A PostgREST head count: `.select("id", head)`, perhaps `.eq(...)`, awaited. */
function headCount(count: number) {
  const chain = {
    eq: () => chain,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ count, error: null }).then(resolve, reject),
  };
  return { select: () => chain };
}

/** The server's tree, inside the provider the layout gives its client parts (the notice). */
async function renderPage() {
  const page = await AdminDashboardPage();
  return render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      {page}
    </NextIntlClientProvider>,
  );
}

const figure = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
const percent = (share: number) =>
  new Intl.NumberFormat("sv", { style: "percent", maximumFractionDigits: 0 }).format(share);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
  from.mockReset();
  from.mockImplementation(() => headCount(7));
  serverApiGet.mockReset();
  serverApiGet.mockImplementation(async (path: string) =>
    path === "/api/v1/users/counts"
      ? state.people
      : path.startsWith("/api/v1/attendance/summary")
        ? state.attendance
        : { error: `unexpected ${path}` },
  );
  state.people = { data: { byRole: { STUDENT: 412, TEACHER: 38, GUARDIAN: 690, SCHOOL_ADMIN: 2 } } };
  state.attendance = { data: { recorded: 200, present: 180 } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the admin dashboard's figures", () => {
  it("counts pupils, teachers and the week's attendance through the gateway, as the signed-in admin", async () => {
    await renderPage();

    expect(figure(sv.dashboard.students)).toBe("412");
    expect(figure(sv.dashboard.teachers)).toBe("38");
    expect(figure(sv.dashboard.attendanceRate)).toBe(percent(0.9));
    expect(figure(sv.dashboard.groups)).toBe("7");
    expect(serverApiGet).toHaveBeenCalledWith("/api/v1/users/counts", "tok-1");
    expect(serverApiGet).toHaveBeenCalledWith("/api/v1/attendance/summary?since=2026-10-06", "tok-1");
    expect(from).not.toHaveBeenCalledWith("Users");
    expect(from).not.toHaveBeenCalledWith("AttendanceRecords");
    expect(screen.queryByText(sv.dashboard.loadFailed)).not.toBeInTheDocument();
  });

  it("shows no people figure, and says so, when the gateway does not answer — never a 0", async () => {
    state.people = { error: "HTTP 503" };
    await renderPage();

    expect(figure(sv.dashboard.students)).toBe("—");
    expect(figure(sv.dashboard.teachers)).toBe("—");
    expect(figure(sv.dashboard.attendanceRate)).toBe(percent(0.9));
    expect(screen.getByText(sv.dashboard.loadFailed)).toBeInTheDocument();
  });

  it("takes an answer without the role's figure for a failure too", async () => {
    state.people = { data: { byRole: { GUARDIAN: 690 } } };
    await renderPage();

    expect(figure(sv.dashboard.students)).toBe("—");
    expect(screen.getByText(sv.dashboard.loadFailed)).toBeInTheDocument();
  });

  it("shows no rate for a week without records, and no failure either", async () => {
    state.attendance = { data: { recorded: 0, present: 0 } };
    await renderPage();

    expect(figure(sv.dashboard.attendanceRate)).toBe("—");
    expect(screen.queryByText(sv.dashboard.loadFailed)).not.toBeInTheDocument();
  });

  it("shows no rate, and says so, when the attendance summary cannot be read", async () => {
    state.attendance = { error: "HTTP 500" };
    await renderPage();

    expect(figure(sv.dashboard.attendanceRate)).toBe("—");
    expect(figure(sv.dashboard.students)).toBe("412");
    expect(screen.getByText(sv.dashboard.loadFailed)).toBeInTheDocument();
  });
});
