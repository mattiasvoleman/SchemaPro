import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import { closedPages, type AdminProfile } from "@/lib/admin-areas";
import { closedMenuStyle, closedPagesFor } from "@/components/admin/area-refusal";
import { ClosedPageGate, ProfileProvider } from "@/components/profile-context";
import type { Profile } from "@/lib/types";

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
    ...rest
  }: {
    href: string;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
    className?: string;
    children?: ReactNode;
    "aria-current"?: "page";
  }) => (
    <a
      href={href}
      className={className}
      // aria-current passes through: it is the active state's real signal.
      {...rest}
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

vi.mock("@/components/layout/document-title", () => ({ DocumentTitle: () => null }));

// Namespace-aware key echo: pins which namespace each label comes from, and
// the values a message is given.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
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
/** The sidebar's own links, without the skip link that precedes it. */
const navLinks = () => within(screen.getByRole("navigation", { name: "nav.label" })).getAllByRole("link");

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

    expect(screen.getByText("nav.basics")).toBeInTheDocument();
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
    // The one empty state became two (2026-10-11), each naming what is
    // missing, classes or subjects; both still call the rows timplansposter.
    expect(sv.requirements.noClasses).toMatch(/^En timplanspost/);
    expect(sv.requirements.noSubjects).toMatch(/^En timplanspost/);
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
    expect(en.requirements.noClasses).toMatch(/^A curriculum entry/);
    expect(en.requirements.noSubjects).toMatch(/^A curriculum entry/);
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
    // The mentor's leave inbox (20261023091000), whether or not the school delegates.
    expect(link("nav.myLeave")).toHaveAttribute("href", "/teacher/ledighet");
    expect(link("nav.calendarFeed")).toHaveAttribute("href", "/calendar-feed");

    expect(screen.queryByRole("link", { name: "nav.subjects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "nav.coverBoard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "nav.leaveRequests" })).not.toBeInTheDocument();
    expect(screen.queryByText("nav.planning")).not.toBeInTheDocument();
    // Counted inside the nav: the skip link is a link too, and not an entry.
    expect(navLinks()).toHaveLength(7);

  });

  it("student gets schedule and attendance links", () => {
    navState.pathname = "/student";
    renderShell({ role: "STUDENT" });

    expect(link("nav.mySchedule")).toHaveAttribute("href", "/student");
    expect(link("nav.myAttendance")).toHaveAttribute("href", "/student/attendance");
    expect(link("nav.calendarFeed")).toHaveAttribute("href", "/calendar-feed");
    expect(navLinks()).toHaveLength(3);
  });

  it("guardian gets a single my-children link", () => {
    navState.pathname = "/guardian";
    renderShell({ role: "GUARDIAN" });

    expect(link("nav.myChildren")).toHaveAttribute("href", "/guardian");
    expect(link("nav.calendarFeed")).toHaveAttribute("href", "/calendar-feed");
    expect(navLinks()).toHaveLength(2);
  });

  it("groups the admin menu by the manual's four phases, Dataskydd and Integrationer last and unlabelled", () => {
    renderShell();

    // Each labelled group is a list named by its label; the order inside is
    // the order a school works through the phase (regrouped 2026-10-11).
    const group = (labelKey: string) =>
      within(screen.getByRole("list", { name: labelKey }))
        .getAllByRole("link")
        .map((entry) => entry.textContent);
    expect(group("nav.basics")).toEqual([
      "nav.setup",
      "nav.years",
      "nav.subjects",
      "nav.rooms",
      "nav.groups",
      "nav.people",
    ]);
    expect(group("nav.planning")).toEqual([
      "nav.timplan",
      "nav.requirements",
      "nav.staffing",
      "nav.constraints",
      "nav.breaks",
      "nav.frameTimes",
      "nav.rasts",
      "nav.lunchServings",
    ]);
    expect(group("nav.scheduling")).toEqual([
      "nav.generate",
      "nav.timetable",
      "nav.gaps",
      "nav.publishing",
      "nav.calendarFeeds",
    ]);
    expect(group("nav.operations")).toEqual([
      "nav.dayPlanner",
      "nav.teacherAbsence",
      "nav.coverBoard",
      "nav.cancellations",
      "nav.leaveRequests",
      "nav.roomBookings",
      "nav.reports",
    ]);

    // Översikt first and Integrationer last, each in a group without a label;
    // Dataskydd och gallring, set up once like it, just before it.
    const all = navLinks();
    expect(all[0]).toHaveTextContent("nav.dashboard");
    // The admin's own calendar feed beside it, which every profile may make.
    expect(all[1]).toHaveTextContent("nav.calendarFeed");
    expect(all[1]).toHaveAttribute("href", "/calendar-feed");
    expect(all[all.length - 2]).toHaveTextContent("nav.dataProtection");
    expect(all[all.length - 2]).toHaveAttribute("href", "/admin/dataskydd");
    expect(all[all.length - 1]).toHaveTextContent("nav.integrations");
    expect(all).toHaveLength(30);
  });

  it("writes the nav's titles with 'och', as the pages' own titles do", async () => {
    const sv = (await import("@/messages/sv.json")).default as { nav: Record<string, string> };
    expect(sv.nav.basics).toBe("Grunddata");
    expect(sv.nav.breaks).toBe("Lov och studiedagar");
    expect(sv.nav.gaps).toBe("Luckor och håltimmar");
    expect(sv.nav.myCover).toBe("Vikariepass och frånvaro");
    expect(Object.values(sv.nav).filter((label) => label.includes("&"))).toEqual([]);
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
// Active-item highlighting: aria-current="page" says it to assistive tech,
// and the bg-sidebar-accent class draws it.
// ---------------------------------------------------------------------------

describe("AppShell active item", () => {
  it("marks the dashboard active only on the exact root path", () => {
    navState.pathname = "/admin";
    renderShell();

    expect(link("nav.dashboard")).toHaveClass("bg-sidebar-accent");
    expect(link("nav.dashboard")).toHaveAttribute("aria-current", "page");
    expect(link("nav.subjects")).not.toHaveClass("bg-sidebar-accent");
    expect(link("nav.subjects")).not.toHaveAttribute("aria-current");
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
    expect(link("nav.subjects")).toHaveAttribute("aria-current", "page");
    expect(link("nav.dashboard")).not.toHaveClass("bg-sidebar-accent");
    expect(link("nav.dashboard")).not.toHaveAttribute("aria-current");
  });

  it("marks one item current on the school's calendar feeds, beside Publicering", () => {
    navState.pathname = "/admin/calendar-feeds";
    renderShell();
    expect(link("nav.calendarFeeds")).toHaveAttribute("aria-current", "page");
    expect(link("nav.publishing")).not.toHaveAttribute("aria-current");
    expect(document.querySelectorAll('nav [aria-current="page"]')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Skip link
// ---------------------------------------------------------------------------

describe("AppShell skip link", () => {
  it("is the first link and targets a focusable main", () => {
    const { container } = renderShell();

    const skip = screen.getAllByRole("link")[0];
    expect(skip).toHaveTextContent("common.skipToContent");
    expect(skip).toHaveAttribute("href", "#main");

    const main = container.querySelector("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });
});

// ---------------------------------------------------------------------------
// Mobile drawer
// ---------------------------------------------------------------------------

describe("AppShell mobile drawer", () => {
  it("is a modal dialog: named, focus moved in on open and back on Escape", async () => {
    const user = userEvent.setup();
    renderShell();

    const hamburger = screen.getByRole("button", { name: "common.openMenu" });
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(hamburger);

    const drawer = screen.getByRole("dialog", { name: "nav.label" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(hamburger).toHaveAttribute("aria-expanded", "true");
    expect(hamburger).toHaveAttribute("aria-controls", drawer.id);
    expect(screen.getByRole("button", { name: "common.close" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(hamburger).toHaveFocus();
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps Tab inside the drawer, wrapping at both ends", async () => {
    const user = userEvent.setup();
    navState.pathname = "/guardian";
    renderShell({ role: "GUARDIAN" });

    await user.click(screen.getByRole("button", { name: "common.openMenu" }));
    const drawer = screen.getByRole("dialog");
    const close = within(drawer).getByRole("button", { name: "common.close" });
    const children = within(drawer).getByRole("link", { name: "nav.myChildren" });
    const feed = within(drawer).getByRole("link", { name: "nav.calendarFeed" });
    // Below the menu, the tillgänglighetsredogörelse: the drawer's last stop.
    const statement = within(drawer).getByRole("link", { name: "accessibilityStatement.link" });
    expect(close).toHaveFocus();

    await user.tab();
    expect(children).toHaveFocus();
    await user.tab();
    expect(feed).toHaveFocus();
    await user.tab();
    expect(statement).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(statement).toHaveFocus();
  });

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

// ---------------------------------------------------------------------------
// Roller i skolan: the admin menu shows the areas the profile writes
// ---------------------------------------------------------------------------

/** The menu's closed paths as the (app) layout works them out on the server. */
const closedFor = (profile: AdminProfile) => closedPagesFor(closedPages(profile), profile, "sv");

/**
 * The menu's style rule as the (app) layout writes it, put in the document's
 * head as text: the layout renders it in a <style> on the server, and a
 * stylesheet applies wherever it sits. Taken out again after each test.
 */
const menuStyles: HTMLStyleElement[] = [];
afterEach(() => {
  for (const style of menuStyles.splice(0)) style.remove();
});

/** The shell as the (app) layout renders it for a profile: inside the provider, the page behind the gate. */
const shellFor = (profile: AdminProfile, body = "page body") => {
  const style = document.createElement("style");
  style.textContent = closedMenuStyle(closedPages(profile), "nav.label");
  document.head.append(style);
  menuStyles.push(style);
  return render(
    <ProfileProvider profile={{ adminProfile: profile } as Profile} school={null} closed={closedFor(profile)}>
      <AppShell role="SCHOOL_ADMIN" userName="Alma Berg" email="alma@example.com" schoolName="Norra Real">
        <ClosedPageGate>
          <p>{body}</p>
        </ClosedPageGate>
      </AppShell>
    </ProfileProvider>,
  );
};

describe("AppShell navigation by administrator profile", () => {
  const hrefs = () => navLinks().map((anchor) => anchor.getAttribute("href"));

  it("shows a full administrator every page, as before profiles", () => {
    shellFor("FULL");
    expect(hrefs()).toEqual(expect.arrayContaining(["/admin/people", "/admin/timetable", "/admin/dataskydd", "/admin/integrations"]));
  });

  it("shows the expedition the school day and the roster, and nothing it does not change", () => {
    shellFor("EXPEDITION");
    expect(hrefs()).toEqual(
      expect.arrayContaining(["/admin", "/admin/people", "/admin/teacher-absence", "/admin/leave", "/admin/cover"]),
    );
    for (const href of ["/admin/timetable", "/admin/generate", "/admin/publishing", "/admin/calendar-feeds", "/admin/subjects", "/admin/dataskydd", "/admin/integrations"]) {
      expect(hrefs()).not.toContain(href);
    }
    // Their own calendar feed is every profile's: the school's switches are not.
    expect(hrefs()).toContain("/calendar-feed");
    // A group with nothing left in it goes with its pages (both hidden by
    // the layout's style rule, so out of the accessibility tree too).
    for (const group of screen.getAllByText("nav.planning")) expect(group).not.toBeVisible();
    for (const group of screen.getAllByText("nav.scheduling")) expect(group).not.toBeVisible();
    expect(screen.getAllByText("nav.operations")[0]).toBeVisible();
  });

  it("shows the planner planning, scheduling, publishing and the day, and not the roster or the decisions", () => {
    shellFor("SCHEMALAGGARE");
    // Personer too: its arbetstid, behörigheter and uppdrag are planering's.
    expect(hrefs()).toEqual(
      expect.arrayContaining(["/admin/subjects", "/admin/staffing", "/admin/timetable", "/admin/publishing", "/admin/cover", "/admin/people"]),
    );
    for (const href of ["/admin/dataskydd", "/admin/integrations"]) {
      expect(hrefs()).not.toContain(href);
    }
  });

  it("shows rektor the decisions too", () => {
    shellFor("REKTOR");
    expect(hrefs()).toEqual(expect.arrayContaining(["/admin/dataskydd", "/admin/people", "/admin/integrations"]));
  });
});

describe("AppShell in place of an admin page the profile does not use", () => {
  it("shows the page to a profile that writes its area", () => {
    navState.pathname = "/admin/people";
    shellFor("EXPEDITION", "the roster");
    expect(screen.getByText("the roster")).toBeInTheDocument();
  });

  it("says which area a page belongs to, and leads back, instead of its buttons", async () => {
    navState.pathname = "/admin/timetable";
    shellFor("EXPEDITION", "the timetable");
    expect(screen.queryByText("the timetable")).not.toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { level: 1 })).toHaveTextContent("adminAreas.gateTitle");
    expect(within(main).getByRole("heading", { level: 2 })).toHaveTextContent("adminAreas.area.SCHEMALAGGNING");
    expect(
      within(main).getByText(/adminAreas\.gateArea\(adminAreas\.area\.SCHEMALAGGNING\|adminAreas\.profile\.EXPEDITION\)/),
    ).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "adminAreas.gateBack" })).toHaveAttribute("href", "/sv/admin");
    // The shell around it stays: the menu still leads where the profile works.
    expect(link("nav.people")).toBeInTheDocument();
  });

  it("refuses a page's sub-pages with it, and not a page that only starts alike", async () => {
    navState.pathname = "/admin/staffing/uppdragsbeskrivning/t-1";
    shellFor("EXPEDITION", "a description");
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 2 })).toHaveTextContent(
      "adminAreas.area.PLANERING",
    );
  });

  it("keeps the decisions to rektor and a full administrator", async () => {
    navState.pathname = "/admin/dataskydd";
    const { unmount } = shellFor("SCHEMALAGGARE", "gallring");
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 2 })).toHaveTextContent(
      "adminAreas.decisions",
    );
    unmount();
    shellFor("REKTOR", "gallring");
    expect(screen.getByText("gallring")).toBeInTheDocument();
  });
});
