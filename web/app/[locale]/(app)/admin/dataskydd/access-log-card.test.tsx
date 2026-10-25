import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { Person } from "@/lib/types";
import { AccessLogCard } from "./access-log-card";
import { accessLogRows } from "./access-log-csv";
import type { AccessLogAnswer } from "./use-access-log";

/**
 * Vem har läst om en person? over the real hooks and the real Swedish
 * messages, the gateway answering by path. What this card decides: nothing
 * is asked until the button (every answer is itself recorded), the picker
 * groups the school's people, a reader is named (a person, a key, or gone),
 * a cut answer says so, a refusal's sentence, and the export's rows.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const csv = vi.hoisted(() => ({ downloadCsv: vi.fn(), serializeCsv: vi.fn((headers: string[], rows: string[][]) => JSON.stringify([headers, ...rows])) }));
vi.mock("@/lib/csv-export", () => csv);

const PUPIL = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const person = (id: string, firstName: string, lastName: string, role: Person["role"], isActive = true): Person => ({
  id, firstName, lastName, role, isActive, email: `${firstName.toLowerCase()}@x`, phone: null, invitedAt: null, studentGroupId: null,
});
const PEOPLE = [
  person(PUPIL, "Ada", "Ek", "STUDENT"),
  person("t", "Bo", "Ås", "TEACHER"),
  person("g", "Gun", "Ek", "GUARDIAN"),
  person("old", "Olle", "Berg", "STUDENT", false),
];

const answer = (patch: Partial<AccessLogAnswer> = {}): AccessLogAnswer => ({
  person: { id: PUPIL, firstName: "Ada", lastName: "Ek", role: "STUDENT" },
  timezone: "Europe/Stockholm",
  from: null,
  to: null,
  truncated: false,
  entries: [
    { id: "e3", at: "2026-10-13T07:15:00.000Z", kind: "ROSTER", channel: "APP", reader: { type: "PERSON", id: "t", name: "Bo Ås", role: "TEACHER" }, others: 24 },
    { id: "e2", at: "2026-10-12T10:00:00.000Z", kind: "PEOPLE", channel: "INTEGRATION", reader: { type: "KEY", id: "k", name: "Elevregistret" }, others: 0 },
    { id: "e1", at: "2026-10-11T10:00:00.000Z", kind: "GUARDIANS", channel: "WEB", reader: { type: "PERSON", id: null, name: null, role: "SCHOOL_ADMIN" }, others: 1 },
  ],
  ...patch,
});

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <AccessLogCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The picker once the school's people have come. */
async function choosePupil(user: ReturnType<typeof userEvent.setup>) {
  const select = await screen.findByLabelText("Person");
  await within(select).findByRole("option", { name: "Ek, Ada" });
  await user.selectOptions(select, PUPIL);
}

const from = () => screen.getByRole("textbox", { name: /^Från/ });
const to = () => screen.getByRole("textbox", { name: /^Till/ });

const asked = () => get.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith("/api/v1/access-log"));

describe("Vem har läst om en person?", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/users") return PEOPLE;
      if (path === "/api/v1/retention/purged-before") return [];
      if (path.startsWith("/api/v1/access-log")) return answer();
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it("asks nothing until the button, and then exactly the person and period chosen", async () => {
    const user = userEvent.setup();
    renderCard();
    const select = await screen.findByLabelText("Person");
    await waitFor(() => expect(within(select).getByRole("option", { name: "Ek, Ada" })).toBeInTheDocument());
    // Grouped by role, a deactivated person said so.
    expect(within(select).getByRole("group", { name: "Elever" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Berg, Olle (avaktiverad)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visa läsningar" })).toBeDisabled();
    expect(screen.getByText("Din sökning skrivs också i läsloggen.")).toBeInTheDocument();

    await user.selectOptions(select, PUPIL);
    expect(asked()).toEqual([]);
    await user.type(from(), "2026-10-01");
    expect(asked()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    await screen.findByText("3 läsningar om Ada Ek, av 3 läsare.");
    expect(asked()).toEqual([`/api/v1/access-log?personId=${PUPIL}&from=2026-10-01`]);
  });

  it("names the huvudman's reader and key with their huvudman (Huvudman)", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/users") return PEOPLE;
      if (path === "/api/v1/retention/purged-before") return [];
      if (path.startsWith("/api/v1/access-log"))
        return answer({
          entries: [
            {
              id: "h2", at: "2026-10-13T07:15:00.000Z", kind: "PEOPLE", channel: "WEB",
              reader: { type: "PERSON", id: "m", name: "Pia Planerare", role: "SCHOOL_ADMIN", huvudman: { name: "Vimmerby kommun", role: "PLANERARE" } },
              others: 0,
            },
            {
              id: "h1", at: "2026-10-12T10:00:00.000Z", kind: "PEOPLE", channel: "INTEGRATION",
              reader: { type: "KEY", id: "hk", name: "Elevregistret", huvudman: { name: "Vimmerby kommun", role: null } },
              others: 0,
            },
          ],
        });
      throw new Error(`unexpected GET ${path}`);
    });
    const user = userEvent.setup();
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    const table = await screen.findByRole("table", { name: "Läsningar om Ada Ek" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows.map((row) => row.slice(1, 3))).toEqual([
      ["Pia Planerare (Vimmerby kommun)", "Huvudmannens planerare"],
      ["Integration: Elevregistret (Vimmerby kommun)", "–"],
    ]);
  });

  it("names each reader: a person with their role, an integration by its key, and one whose row is gone", async () => {
    const user = userEvent.setup();
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    const table = await screen.findByRole("table", { name: "Läsningar om Ada Ek" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["13 oktober 2026 kl. 09:15", "Bo Ås", "Lärare", "Klasslista", "Appen", "24"],
      [expect.stringContaining("12 oktober 2026"), "Integration: Elevregistret", "–", "Personuppgifter", "Integration", "–"],
      [expect.stringContaining("11 oktober 2026"), "Borttagen person", "Administratör", "Vårdnadshavare", "Webben", "1"],
    ]);
  });

  it("exports the rows as the table names them", async () => {
    const user = userEvent.setup();
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    await user.click(await screen.findByRole("button", { name: "Exportera som CSV" }));
    await waitFor(() => expect(csv.downloadCsv).toHaveBeenCalledTimes(1));
    const [filename, content] = csv.downloadCsv.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^lasningar-ada-ek-\d{4}-\d{2}-\d{2}\.csv$/);
    const [headers, first] = JSON.parse(content) as string[][];
    expect(headers).toEqual(["Tid", "Läsare", "Roll", "Uppgift", "Kanal", "Fler i samma läsning"]);
    expect(first!.slice(1)).toEqual(["Bo Ås", "Lärare", "Klasslista", "Appen", "24"]);
  });

  it("says when nobody has read about the person, and when the answer was cut", async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/users") return PEOPLE;
      if (path === "/api/v1/retention/purged-before") return [];
      return answer({ entries: [] });
    });
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    expect(await screen.findByText("Ingen har läst om Ada Ek under perioden.")).toBeInTheDocument();
    expect(screen.queryByText(/är gallrade enligt skolans beslut/)).not.toBeInTheDocument();

    get.mockImplementation(async (path: string) =>
      path === "/api/v1/users" ? PEOPLE : path === "/api/v1/retention/purged-before" ? [] : answer({ truncated: true }),
    );
    await user.type(to(), "2026-10-13");
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    expect(await screen.findByText("Bara de senaste läsningarna visas")).toBeInTheDocument();
  });

  it("refuses a period that ends before it begins without asking, and says the gateway's refusal in Swedish", async () => {
    const user = userEvent.setup();
    renderCard();
    await choosePupil(user);
    await user.type(from(), "2026-10-13");
    await user.type(to(), "2026-10-01");
    expect(screen.getByText("Perioden börjar efter att den slutar.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visa läsningar" })).toBeDisabled();

    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/users") return PEOPLE;
      if (path === "/api/v1/retention/purged-before") return [];
      throw new ApiError(404, "Personen finns inte i skolan.", "ACCESS_LOG_PERSON_NOT_FOUND");
    });
    await user.clear(to());
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    expect(await screen.findByText("Personen finns inte i skolan.")).toBeInTheDocument();
  });

  it("says when the log is gallrat before the period asked, rather than letting a short answer read as nobody", async () => {
    const user = userEvent.setup();
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/users") return PEOPLE;
      if (path === "/api/v1/retention/purged-before") return [{ dataType: "ACCESS_LOG", purgedBefore: "2025-10-13" }];
      return answer({ entries: [] });
    });
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    expect(await screen.findByText("Läsningar före 13 oktober 2025 är gallrade enligt skolans beslut.")).toBeInTheDocument();
    expect(screen.getByText("Ingen har läst om Ada Ek under perioden.")).toBeInTheDocument();
  });

  it("asks again on every press, the same person and period too, and exports the fresh answer", async () => {
    const user = userEvent.setup();
    let calls = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/users") return PEOPLE;
      if (path === "/api/v1/retention/purged-before") return [];
      calls += 1;
      return calls === 1 ? answer({ entries: answer().entries.slice(0, 1) }) : answer();
    });
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    await screen.findByText("1 läsning om Ada Ek, av 1 läsare.");
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    await screen.findByText("3 läsningar om Ada Ek, av 3 läsare.");
    expect(asked()).toEqual([`/api/v1/access-log?personId=${PUPIL}`, `/api/v1/access-log?personId=${PUPIL}`]);
    await user.click(screen.getByRole("button", { name: "Exportera som CSV" }));
    await waitFor(() => expect(csv.downloadCsv).toHaveBeenCalledTimes(1));
    const [, content] = csv.downloadCsv.mock.calls[0] as [string, string];
    expect((JSON.parse(content) as string[][]).length).toBe(4);
  });

  it("announces only the sentence: the table is outside the live region", async () => {
    const user = userEvent.setup();
    renderCard();
    await choosePupil(user);
    await user.click(screen.getByRole("button", { name: "Visa läsningar" }));
    const status = await screen.findByRole("status");
    await within(status).findByText("3 läsningar om Ada Ek, av 3 läsare.");
    const table = await screen.findByRole("table", { name: "Läsningar om Ada Ek" });
    expect(status.contains(table)).toBe(false);
    expect(within(status).queryByRole("button")).toBeNull();
  });

  it("builds one export row per entry, the count of others as a number", () => {
    const rows = accessLogRows(answer().entries, {
      headers: [],
      when: (entry) => entry.at,
      reader: (entry) => entry.reader.name ?? "?",
      role: () => "r",
      kind: (entry) => entry.kind,
      channel: (entry) => entry.channel,
    });
    expect(rows.map((row) => row[5])).toEqual(["24", "0", "1"]);
  });
});
