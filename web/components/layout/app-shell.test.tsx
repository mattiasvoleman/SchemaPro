import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

// ---------------------------------------------------------------------------
// Boundary mocks. The four header widgets (locale switcher, theme toggle,
// bell, user menu) each drag in their own providers (react-query, supabase,
// next-themes) and have their own specs; here they are stubbed so this file
// tests only the shell's behaviour: nav-by-role, active highlighting and the
// mobile drawer.
// ---------------------------------------------------------------------------

const navState = vi.hoisted(() => ({ pathname: "/admin" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => navState.pathname,
  Link: ({
    href,
    onClick,
    className,
    children,
  }: {
    href: string;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
    children?: ReactNode;
  }) => (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        // jsdom cannot navigate; the shell's onClick (drawer close) still runs.
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("./locale-switcher", () => ({
  LocaleSwitcher: () => <div data-testid="locale-switcher" />,
}));
vi.mock("./theme-toggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock("@/components/layout/notification-bell", () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));
vi.mock("./user-menu", () => ({
  UserMenu: (props: { userName: string; email: string; role: string }) => (
    <div data-testid="user-menu">{`${props.userName}|${props.email}|${props.role}`}</div>
  ),
}));

// Namespace-aware key echo: pins which namespace each label comes from.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

function renderShell(overrides: Partial<ComponentProps<typeof AppShell>> = {}) {
  return render(
    <AppShell
      role="SCHOOL_ADMIN"
      userName="Alma Berg"
      email="alma@example.com"
      schoolName="Norra Real"
      {...overrides}
    >
      <p>page body</p>
    </AppShell>,
  );
}

const link = (name: string) => screen.getByRole("link", { name });

beforeEach(() => {
  navState.pathname = "/admin";
});

// ---------------------------------------------------------------------------
// Navigation per role
// ---------------------------------------------------------------------------

describe("AppShell navigation", () => {
  it("renders the admin sections, branded header and page body", () => {
    renderShell();

    expect(screen.getByText("common.appName")).toBeInTheDocument();
    expect(screen.getByText("Norra Real")).toBeInTheDocument();
    expect(screen.getByText("page body")).toBeInTheDocument();

    expect(screen.getByText("nav.planning")).toBeInTheDocument();
    expect(screen.getByText("nav.scheduling")).toBeInTheDocument();
    expect(screen.getByText("nav.operations")).toBeInTheDocument();

    expect(link("nav.dashboard")).toHaveAttribute("href", "/admin");
    expect(link("nav.subjects")).toHaveAttribute("href", "/admin/subjects");
    expect(link("nav.generate")).toHaveAttribute("href", "/admin/generate");
    expect(link("nav.timetable")).toHaveAttribute("href", "/admin/timetable");
    expect(link("nav.integrations")).toHaveAttribute("href", "/admin/integrations");
    expect(link("nav.coverBoard")).toHaveAttribute("href", "/admin/cover");
  });

  it("gives the name Timplan to the lokal timplan and keeps the requirements route under its new label", () => {
    renderShell();

    // The target page first, then the posts that are written to meet it.
    const timplan = link("nav.timplan");
    expect(timplan).toHaveAttribute("href", "/admin/timplan");
    const requirements = screen.getByRole("link", { name: /nav\.requirements/ });
    expect(requirements).toHaveAttribute("href", "/admin/requirements");
    expect(
      timplan.compareDocumentPosition(requirements) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The one-release "Hette tidigare Timplan" line has had its release: the
    // entry is its name alone again.
    expect(requirements).toHaveTextContent(/^nav\.requirements$/);
  });

  it("names the two pages Timplan and Timplansposter in Swedish, the old name no longer stated", async () => {
    const sv = (await import("@/messages/sv.json")).default as { nav: Record<string, string> };
    const en = (await import("@/messages/en.json")).default as { nav: Record<string, string> };
    expect(sv.nav.timplan).toBe("Timplan");
    expect(sv.nav.requirements).toBe("Timplansposter");
    expect(sv.nav).not.toHaveProperty("requirementsFormerly");
    expect(en.nav).not.toHaveProperty("requirementsFormerly");
    expect(en.nav.requirements).not.toBe(en.nav.timplan);
  });

  it("calls the requirements matrix's contents Timplansposter where a user decides where to go", async () => {
    // The nav moved the name Timplan to the lokal timplan, which the engine
    // does not read; the empty state, the table caption and the engine's
    // "nothing to place" still sent the admin to "the timplan".
    type Messages = {
      requirements: Record<string, string>;
      engineMessages: Record<string, string>;
      timplan: Record<string, string>;
    };
    const sv = (await import("@/messages/sv.json")).default as unknown as Messages;
    const en = (await import("@/messages/en.json")).default as unknown as Messages;
    expect(sv.requirements.empty).toMatch(/^Inga timplansposter/);
    expect(sv.requirements.tableCaption).toMatch(/^Timplansposter per grupp/);
    expect(sv.engineMessages.INPUT_NO_REQUIREMENTS).toContain("timplansposter");
    // The pages that speak of the posts' hours, their rows or their file
    // name them as posts; "timplanen" is the lokal timplan now.
    const svAll = (await import("@/messages/sv.json")).default as unknown as Record<
      string,
      Record<string, string>
    >;
    for (const [namespace, key] of [
      ["breaks", "intro"],
      ["breaks", "empty"],
      ["breaks", "deleteBody"],
      ["breaks", "tableCaption"],
      ["generate", "subtitle"],
      ["generate", "noYearTitle"],
      ["csvImport", "updatesNotDeletes"],
      ["gaps", "idlePupilTime"],
      ["staffing", "unstaffedEmpty"],
      ["staffing", "teacherRowsHint"],
    ] as const) {
      expect(svAll[namespace]![key]).toMatch(/[Tt]implansposte/);
      expect(svAll[namespace]![key]).not.toMatch(/[Tt]implanen|[Tt]implanens/);
    }
    expect(en.requirements.empty).toMatch(/^No curriculum entries/);
    expect(en.requirements.tableCaption).toMatch(/^Curriculum entries by group/);
    // The English is the engine's own sentence (i18n/engine-messages.test.ts
    // holds the two identical), so it changes in optimization-engine, not here.
    // A copy keeps the school form (CopyLocalTimplanDto has only a name), so
    // the create dialog may not offer it as the way to another one.
    expect(sv.timplan.createBody).not.toMatch(/kopia/);
    expect(sv.timplan.createBody).toContain("skapar du en ny timplan");
    expect(en.timplan.createBody).not.toMatch(/copy/);
  });

  it("teacher gets the teacher nav, without admin entries or section labels", () => {
    navState.pathname = "/teacher";
    renderShell({ role: "TEACHER" });

    expect(link("nav.mySchedule")).toHaveAttribute("href", "/teacher");
    expect(link("nav.attendance")).toHaveAttribute("href", "/teacher/attendance");
    expect(link("nav.roomBooking")).toHaveAttribute("href", "/teacher/rooms");
    expect(link("nav.myStaffing")).toHaveAttribute("href", "/teacher/tjanst");
    expect(link("nav.myCover")).toHaveAttribute("href", "/teacher/franvaro");

    expect(screen.queryByRole("link", { name: "nav.subjects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "nav.coverBoard" })).not.toBeInTheDocument();
    expect(screen.queryByText("nav.planning")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(5);

  });

  it("student gets schedule and attendance links", () => {
    navState.pathname = "/student";
    renderShell({ role: "STUDENT" });

    expect(link("nav.mySchedule")).toHaveAttribute("href", "/student");
    expect(link("nav.myAttendance")).toHaveAttribute("href", "/student/attendance");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("guardian gets a single my-children link", () => {
    navState.pathname = "/guardian";
    renderShell({ role: "GUARDIAN" });

    expect(link("nav.myChildren")).toHaveAttribute("href", "/guardian");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("forwards identity to the user menu and mounts the header widgets", () => {
    renderShell();

    expect(
      screen.getByText("Alma Berg|alma@example.com|SCHOOL_ADMIN"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("locale-switcher")).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Active-item highlighting. There is no aria-current, so the computed class is
// the only observable signal of the active state.
// ---------------------------------------------------------------------------

describe("AppShell active item", () => {
  it("marks the dashboard active only on the exact root path", () => {
    navState.pathname = "/admin";
    renderShell();

    expect(link("nav.dashboard")).toHaveClass("bg-sidebar-accent");
    expect(link("nav.subjects")).not.toHaveClass("bg-sidebar-accent");
  });

  it("keeps the dashboard inactive on sibling routes (no prefix match for the root)", () => {
    navState.pathname = "/admin/setup";
    renderShell();

    expect(link("nav.dashboard")).not.toHaveClass("bg-sidebar-accent");
    expect(link("nav.setup")).toHaveClass("bg-sidebar-accent");
  });

  it("marks a section item active on its sub-routes", () => {
    navState.pathname = "/admin/subjects/s-9";
    renderShell();

    expect(link("nav.subjects")).toHaveClass("bg-sidebar-accent");
    expect(link("nav.dashboard")).not.toHaveClass("bg-sidebar-accent");
  });
});

// ---------------------------------------------------------------------------
// Mobile drawer
// ---------------------------------------------------------------------------

describe("AppShell mobile drawer", () => {
  it("opens a second sidebar and closes via the close button", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(
      screen.queryByRole("button", { name: "common.close" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("common.appName")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "common.openMenu" }));

    expect(screen.getByRole("button", { name: "common.close" })).toBeInTheDocument();
    expect(screen.getAllByText("common.appName")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "common.close" }));

    expect(
      screen.queryByRole("button", { name: "common.close" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("common.appName")).toHaveLength(1);
  });

  it("closes when a drawer nav link is clicked", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "common.openMenu" }));
    const dashboards = screen.getAllByRole("link", { name: "nav.dashboard" });
    expect(dashboards).toHaveLength(2);

    // Index 1 is the drawer copy (the desktop sidebar renders first).
    await user.click(dashboards[1]);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "common.close" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("closes when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const { container } = renderShell();

    await user.click(screen.getByRole("button", { name: "common.openMenu" }));

    // The backdrop is a purely decorative overlay with no accessible handle,
    // so the class token is the only way to reach it.
    const backdrop = container.querySelector('[class~="bg-black/50"]');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);

    expect(
      screen.queryByRole("button", { name: "common.close" }),
    ).not.toBeInTheDocument();
  });
});

describe("AppShell content width", () => {
  it("lets the content column shrink to the viewport", () => {
    // A flex item defaults to min-width: auto and will not shrink below its
    // content's min-content width. Without min-w-0 a single wide page — the
    // timplan with two dozen subjects — stretched this column past the
    // viewport, and everything anchored to its right edge (the academic-year
    // picker, the user menu) sat off-screen until you scrolled sideways.
    // jsdom computes no layout, so the class is what can be asserted; the
    // behaviour itself was verified in a browser against the same structure.
    const { container } = renderShell();

    const column = container.querySelector("main")?.parentElement;
    expect(column).not.toBeNull();
    expect(column?.className).toContain("flex-1");
    expect(column?.className).toContain("min-w-0");
  });
});
