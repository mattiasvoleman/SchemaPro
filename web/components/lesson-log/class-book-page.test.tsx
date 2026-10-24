import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { api } from "@/lib/api";
import type { ClassBook } from "@/lib/lesson-log";
import { ClassBookPage } from "./class-book-page";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

/**
 * The klassbok: the class and period are the URL's, the lessons come grouped
 * by day with what was written, another group's lesson says how many of the
 * class are on it, and only the administrator's page offers to remove a log,
 * behind data-writes="DRIFT".
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), put: vi.fn() } };
});
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/teacher/klassbok",
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ activeYear: { id: "y-now", isActive: true } }),
  useGroups: () => ({
    data: [
      { id: "g-7a", name: "7A", kind: "CLASS", academicYearId: "y-now" },
      { id: "g-sp", name: "Spanska 7", kind: "TEACHING_GROUP", academicYearId: "y-now" },
      { id: "g-old", name: "6A", kind: "CLASS", academicYearId: "y-last" },
    ],
  }),
}));

const BOOK: ClassBook = {
  school: "Norra skolan",
  group: { id: "g-7a", name: "7A", kind: "CLASS" },
  from: "2026-10-19",
  to: "2026-10-23",
  timezone: "Europe/Stockholm",
  pupils: 24,
  lessons: [
    {
      id: "l-1",
      date: "2026-10-19",
      start: "08:00",
      end: "08:45",
      status: "SCHEDULED",
      subject: "Matematik",
      groups: ["7A"],
      room: "B204",
      teachers: [{ name: "Bo Berg", substitute: true }],
      topic: "Bråk",
      homework: "Uppgift 4.1",
      attending: null,
    },
    {
      id: "l-2",
      date: "2026-10-19",
      start: "10:00",
      end: "10:45",
      status: "CANCELLED",
      subject: "Spanska",
      groups: ["Spanska 7"],
      room: null,
      teachers: [],
      topic: null,
      homework: null,
      attending: 6,
    },
    {
      id: "l-3",
      date: "2026-10-20",
      start: "08:00",
      end: "08:45",
      status: "SCHEDULED",
      subject: "Svenska",
      groups: ["7A"],
      room: null,
      teachers: [{ name: "Anna Lind", substitute: false }],
      topic: null,
      homework: "Läs kapitel 2",
      attending: null,
    },
  ],
};

function renderBook(props: Partial<React.ComponentProps<typeof ClassBookPage>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <ClassBookPage audience="teacher" initialGroupId="g-7a" initialFrom="2026-10-19" initialTo="2026-10-23" {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue(BOOK);
});

describe("the klassbok", () => {
  it("asks for the class and period of the URL and prints them grouped by day, with what was written", async () => {
    renderBook();
    expect(await screen.findByRole("heading", { name: "Klassbok 7A" })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/v1/lesson-logs/class-book?groupId=g-7a&from=2026-10-19&to=2026-10-23");
    expect(screen.getByText(/Norra skolan · .* · 24 elever/)).toBeInTheDocument();
    const monday = screen.getByRole("region", { name: /måndag 19 oktober/i });
    expect(within(monday).getByText("Bråk")).toBeInTheDocument();
    expect(within(monday).getByText("Bo Berg (vikarie) · B204")).toBeInTheDocument();
    expect(within(monday).getByText("Spanska 7, 6 av klassens elever")).toBeInTheDocument();
    expect(within(monday).getByText("Inställd")).toBeInTheDocument();
    expect(within(monday).getByText("Ingen lärare")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /tisdag 20 oktober/i })).toBeInTheDocument();
    // A teacher removes nothing here.
    expect(screen.queryByRole("button", { name: /^Ta bort/ })).not.toBeInTheDocument();
  });

  it("offers this year's classes and teaching groups, and remembers a new choice in the URL", async () => {
    const user = userEvent.setup();
    renderBook();
    const select = await screen.findByRole("combobox", { name: "Klass eller grupp" });
    expect(within(select).queryByRole("option", { name: "6A" })).not.toBeInTheDocument();
    await user.selectOptions(select, "g-sp");
    expect(nav.replace).toHaveBeenLastCalledWith("/teacher/klassbok?group=g-sp&from=2026-10-19&to=2026-10-23", { scroll: false });
  });

  it("asks nothing for a period past 200 days or backwards, and says why", async () => {
    renderBook({ initialFrom: "2026-08-01", initialTo: "2027-02-17" });
    expect(await screen.findByText("Högst 200 dagar åt gången.")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("asks for a class before it asks the gateway", async () => {
    renderBook({ initialGroupId: null });
    expect(await screen.findByText("Välj en klass")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("lets the administrator remove a written log, behind drift, after asking", async () => {
    put.mockResolvedValue({ log: null });
    const user = userEvent.setup();
    renderBook({ audience: "admin" });
    const remove = await screen.findByRole("button", { name: "Ta bort ämne och läxa för Matematik 08:00" });
    expect(remove).toHaveAttribute("data-writes", "DRIFT");
    // A lesson with nothing written has nothing to remove.
    expect(screen.queryByRole("button", { name: "Ta bort ämne och läxa för Spanska 10:00" })).not.toBeInTheDocument();
    await user.click(remove);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Ta bort" }));
    expect(put).toHaveBeenCalledWith("/api/v1/lesson-logs/lessons/l-1", { topic: null, homework: null });
    expect(toast.success).toHaveBeenCalledWith("Ämne och läxa borttagna");
  });
});
