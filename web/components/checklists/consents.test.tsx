import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, toDateString } from "@/lib/utils";
import { CONSENT_ROWS, GROUPS, consentRow, counts, detail, entry, group, listItem } from "@/lib/__fixtures__/checklists";
import { BASE, apiError, installApi, reads, renderChecklists, scenario, warmChecklists, type Scenario } from "@/lib/__fixtures__/checklists-render";
import { Checklists } from "./checklists";

/**
 * Samtycken, as the administrator and the teacher have them: the lists of a
 * class, a new list, one list with where each pupil stands (a consent taken back
 * reads as taken back at once), writing an answer down, asking the guardians
 * through Kvittens, and ending the list. Through the gateway's routes and the
 * real Swedish messages (a key missing from sv.json throws here).
 *
 * What this guards: a list is read when it is opened and not before; the state of
 * a pupil is said in words and an icon as well as a colour; an answer is sent
 * with exactly what the dialog says (today left to the gateway's clock); the
 * guardians are asked only after one question, and only where the school has
 * Kvittens on; and a refusal is said in a sentence with the dialog left open.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));

const day = (iso: string) => new Intl.DateTimeFormat("sv", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const instantDay = (iso: string) => new Intl.DateTimeFormat("sv", { dateStyle: "medium" }).format(new Date(iso));
const TODAY = toDateString(new Date());
const TOMORROW = toDateString(addDays(new Date(), 1));

let state: Scenario;

beforeAll(() => warmChecklists(), 120_000);

// userEvent keeps its default pause between actions: a dialog sets `pointer-events: none` on the page while it opens and `auto` on itself one
// render later, and a user that acts with no pause at all can reach the dialog's field in between (on a slow machine it does).

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  state = scenario();
  installApi(api, state);
  api.post.mockResolvedValue({});
});

/** The page with the Samtycken tab open. */
async function open(audience: "admin" | "teacher" = "admin") {
  const user = userEvent.setup();
  renderChecklists(<Checklists audience={audience} />);
  await user.click(screen.getByRole("tab", { name: "Samtycken" }));
  return user;
}

async function openList(user: ReturnType<typeof userEvent.setup>, title = "Fotografering HT 2026") {
  // By label, not by role: the list's opener names itself with aria-label, and a role query computes the accessibility of the whole page.
  await user.click(await screen.findByLabelText(new RegExp(`^Öppna ${title}`)));
  return screen.findByRole("table", { name: new RegExp(`Eleverna och deras svar på ${title}`) });
}

const rowOf = (table: HTMLElement, name: string) => within(table).getByRole("button", { name: `Öppna elevkort för ${name}` }).closest("tr")!;

describe("the lists", () => {
  it("reads no list until the tab is opened, and then lists them with where each stands, in words and numbers", async () => {
    const user = userEvent.setup();
    renderChecklists(<Checklists audience="admin" />);
    await screen.findByRole("region", { name: "Bocka av" });
    expect(reads(api).some((path) => path.includes("/consent-lists"))).toBe(false);
    await user.click(screen.getByRole("tab", { name: "Samtycken" }));
    const lists = await screen.findAllByRole("listitem");
    const first = lists.find((item) => within(item).queryByText("Fotografering HT 2026"))!;
    expect(reads(api)).toContain(`${BASE}/consent-lists`);
    expect(within(first).getByText("7A")).toBeInTheDocument();
    expect(within(first).getByText(`${instantDay("2026-09-15T08:00:00.000Z")} av Anna Svensson`, { exact: false })).toBeInTheDocument();
    // Every state, a zero too, as a word and a number.
    const numbers = within(first).getAllByRole("definition").map((dd) => dd.textContent);
    expect(numbers).toEqual(["2", "1", "1", "1", "2"]);
    expect(within(first).getAllByRole("term").map((dt) => dt.textContent)).toEqual(["Samtycke", "Har tackat nej", "Återkallat", "Frågad i appen", "Saknas"]);
    // A list made by a person who has left names nobody.
    const second = lists.find((item) => within(item).queryByText("Utflykt till Skansen"))!;
    expect(within(second).getByText(instantDay("2026-09-15T08:00:00.000Z"))).toBeInTheDocument();
  });

  it("filters by class and by ended lists, with the query the gateway takes", async () => {
    const user = await open();
    await screen.findByText("Fotografering HT 2026");
    await user.selectOptions(screen.getByLabelText("Klass"), "g-7a");
    await waitFor(() => expect(reads(api)).toContain(`${BASE}/consent-lists?classId=g-7a`));
    await user.click(screen.getByRole("checkbox", { name: "Visa avslutade" }));
    await waitFor(() => expect(reads(api)).toContain(`${BASE}/consent-lists?classId=g-7a&includeClosed=true`));
    expect(within(screen.getByLabelText("Klass")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Alla klasser", "7A", "8B"]);
  });

  it("marks an ended list, with its day", async () => {
    state.lists = [listItem({ closedAt: "2026-10-20T10:00:00.000Z" })];
    await open();
    expect(await screen.findByText(`Avslutad ${instantDay("2026-10-20T10:00:00.000Z")}`)).toBeInTheDocument();
  });

  it("says no list matches a filter, and that a school with none has none, by who is reading", async () => {
    state.lists = [];
    const user = await open();
    expect(await screen.findByRole("heading", { name: "Inga samtyckeslistor än" })).toBeInTheDocument();
    expect(screen.getByText("När personal gör en samtyckeslista för en klass syns den här.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Visa avslutade" }));
    expect(await screen.findByText("Ingen lista matchar.")).toBeInTheDocument();
  });

  it("tells a teacher to make a list for a class they mentor", async () => {
    state.lists = [];
    await open("teacher");
    expect(await screen.findByText("Gör en lista för en klass du är mentor för, så syns den här.")).toBeInTheDocument();
    expect(screen.getByText(/Listor för klasser du är mentor för/)).toBeInTheDocument();
  });

  it("says the lists could not be fetched, and reads them again", async () => {
    state.fails = { lists: apiError(500) };
    const user = await open();
    expect(await screen.findByText("Listorna kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByText("Fotografering HT 2026")).toBeInTheDocument();
  });

  it("is read-only for a läsare: no way to make a list", async () => {
    profile.readOnly = true;
    await open();
    await screen.findByText("Fotografering HT 2026");
    expect(screen.queryByRole("button", { name: "Ny samtyckeslista" })).not.toBeInTheDocument();
  });
});

describe("a new list", () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "Ny samtyckeslista" }));
    return screen.findByRole("region", { name: "Ny samtyckeslista" });
  };

  it("makes a list of a class, a title and the text, and opens it", async () => {
    api.post.mockResolvedValueOnce(listItem({ id: "l-new", title: "Publicering på webben" }));
    const user = await open();
    const form = await openForm(user);
    expect(form).toBeInTheDocument();
    // The form takes focus (its heading), as a view that opens does.
    expect(screen.getByRole("heading", { name: "Ny samtyckeslista" })).toHaveFocus();
    // Only the classes are offered, not the teaching groups.
    expect(within(screen.getByLabelText("Klass")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Välj klass…", "7A", "8B"]);
    await user.selectOptions(screen.getByLabelText("Klass"), "g-7a");
    await user.type(screen.getByLabelText("Rubrik"), " Publicering på webben ");
    await user.type(screen.getByLabelText("Det vårdnadshavarna ombeds samtycka till"), " Vi publicerar bilder. ");
    expect(screen.getByText(/Genom att bekräfta ger du ditt samtycke/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Gör listan" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists`, { classId: "g-7a", title: "Publicering på webben", body: "Vi publicerar bilder." }),
    );
    // The new list is opened.
    await waitFor(() => expect(reads(api)).toContain(`${BASE}/consent-lists/l-new`));
    expect(await screen.findByRole("heading", { name: "Fotografering HT 2026" })).toBeInTheDocument();
  });

  it("says what is missing, and sends nothing", async () => {
    const user = await open();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Gör listan" }));
    expect(await screen.findByText("Välj en klass.")).toBeInTheDocument();
    expect(screen.getByText("Skriv en rubrik.")).toBeInTheDocument();
    expect(screen.getByText("Skriv det vårdnadshavarna ska samtycka till.")).toBeInTheDocument();
    expect(screen.getByLabelText("Klass")).toHaveFocus();
    await user.selectOptions(screen.getByLabelText("Klass"), "g-7a");
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("x".repeat(121));
    await user.click(screen.getByLabelText("Det vårdnadshavarna ombeds samtycka till"));
    await user.paste("b".repeat(1701));
    await user.click(screen.getByRole("button", { name: "Gör listan" }));
    expect(await screen.findByText("Rubriken får vara högst 120 tecken.")).toBeInTheDocument();
    expect(screen.getByText(/Texten får vara högst 1\s700 tecken\./)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says a class that already has an open list of the name is refused, with the form as it was", async () => {
    api.post.mockRejectedValueOnce(apiError(409, "CONSENT_LIST_EXISTS"));
    const user = await open();
    await openForm(user);
    await user.selectOptions(screen.getByLabelText("Klass"), "g-7a");
    await user.type(screen.getByLabelText("Rubrik"), "Foto");
    await user.type(screen.getByLabelText("Det vårdnadshavarna ombeds samtycka till"), "Vi får fotografera.");
    await user.click(screen.getByRole("button", { name: "Gör listan" }));
    expect(await screen.findByText("Klassen har redan en öppen lista med det namnet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Rubrik")).toHaveValue("Foto");
  });

  it("goes back to the lists on Avbryt", async () => {
    const user = await open();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(await screen.findByRole("button", { name: "Ny samtyckeslista" })).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("tells a teacher they can only make a list for a class they mentor", async () => {
    const user = await open("teacher");
    await openForm(user);
    expect(screen.getByText("Du kan bara göra en lista för en klass där du är mentor.")).toBeInTheDocument();
  });

  it("offers only the classes the gateway says the reader may make a list for", async () => {
    state.groups = [
      group({ id: "g-7a", name: "7A", canMakeList: true }),
      group({ id: "g-9c", name: "9C", subjects: ["Slöjd"], canMakeList: false }),
      group({ id: "g-t", name: "Slöjd 7", kind: "TEACHING_GROUP", canMakeList: true }),
    ];
    const user = await open("teacher");
    await openForm(user);
    expect(within(screen.getByLabelText("Klass")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Välj klass…", "7A"]);
  });

  it("says a teacher who mentors no class cannot make a list, and shows no form", async () => {
    state.groups = [group({ id: "g-9c", name: "9C", canMakeList: false }), group({ id: "g-t", name: "Slöjd 7", kind: "TEACHING_GROUP", canMakeList: false })];
    const user = await open("teacher");
    await openForm(user);
    expect(await screen.findByText("Det finns inga klasser att göra en lista för")).toBeInTheDocument();
    expect(screen.getByText(/inte mentor för någon klass just nu/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gör listan" })).not.toBeInTheDocument();
  });

  it("says a class the reader may not make a list for is refused in a sentence", async () => {
    api.post.mockRejectedValueOnce(apiError(403, "CONSENT_NOT_YOUR_CLASS"));
    const user = await open("teacher");
    await openForm(user);
    await user.selectOptions(screen.getByLabelText("Klass"), "g-7a");
    await user.type(screen.getByLabelText("Rubrik"), "Foto");
    await user.type(screen.getByLabelText("Det vårdnadshavarna ombeds samtycka till"), "Vi får fotografera.");
    await user.click(screen.getByRole("button", { name: "Gör listan" }));
    expect(await screen.findByText("Du kan bara göra samtyckeslistor för klasser du är mentor för.")).toBeInTheDocument();
  });

  it("says the classes could not be fetched, and tries again", async () => {
    state.fails = { groups: apiError(500) };
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny samtyckeslista" }));
    expect(await screen.findByText("Klasserna kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByLabelText("Klass")).toBeInTheDocument();
  });
});

describe("one list", () => {
  it("shows the text, who made it, where everyone stands, and records the reading", async () => {
    const user = await open();
    await openList(user);
    expect(reads(api)).toContain(`${BASE}/consent-lists/l-1`);
    expect(screen.getByRole("heading", { name: "Fotografering HT 2026" })).toBeInTheDocument();
    expect(screen.getByText(/Skolan får fotografera eleven vid skolfotograferingen/)).toBeInTheDocument();
    expect(screen.getByText(`${instantDay("2026-09-15T08:00:00.000Z")} av Anna Svensson`)).toBeInTheDocument();
  });

  it("says each pupil's state as a badge with its words, and a consent taken back at once, with its day", async () => {
    const user = await open();
    const table = await openList(user);
    const states = ["Ada Berg", "Bo Ek", "Cia Lund", "Dan Dal", "Eva Nord", "Fia Ström", "Gun Ö"].map((name) => rowOf(table, name).querySelector("[data-state]")?.getAttribute("data-state"));
    expect(states).toEqual(["GRANTED", "WITHDRAWN", "ASKED", "DECLINED", "GRANTED", "MISSING", "MISSING"]);
    // The words are the badge's: colour is never the only carrier, and each badge has its own icon.
    expect(within(rowOf(table, "Bo Ek")).getByText("Återkallat")).toBeInTheDocument();
    expect(within(rowOf(table, "Bo Ek")).getByText(day("2026-10-04"))).toBeInTheDocument();
    expect(within(rowOf(table, "Dan Dal")).getByText("Har tackat nej")).toBeInTheDocument();
    expect(rowOf(table, "Ada Berg").querySelector("svg")).not.toBeNull();
    const icons = new Set(["Ada Berg", "Bo Ek", "Cia Lund", "Dan Dal", "Gun Ö"].map((name) => rowOf(table, name).querySelector("[data-state] svg")?.getAttribute("class") ?? ""));
    expect(icons.size).toBeGreaterThan(0);
  });

  it("says how an answer came to be: written in from a paper, or confirmed in the app", async () => {
    const user = await open();
    const table = await openList(user);
    expect(
      within(rowOf(table, "Ada Berg")).getByText(`Skrivet in av Anna Svensson den ${instantDay("2026-10-05T09:12:00.000Z")}, lämnat ${day("2026-10-03")} av Adas mamma`),
    ).toBeInTheDocument();
    expect(within(rowOf(table, "Eva Nord")).getByText(`Bekräftat i appen ${day("2026-10-06")}`)).toBeInTheDocument();
    // An answer written in by a person who has left, with no one who gave it.
    expect(within(rowOf(table, "Dan Dal")).getByText(/Skrivet in av Anna Svensson den .*, lämnat .*/)).toBeInTheDocument();
  });

  it("says who a pupil's asked guardians are waited for, and the answer before it", async () => {
    state.detail = detail({
      rows: [
        consentRow("p-cia", "Cia Lund", { state: "ASKED", ask: { askedAt: "2026-10-06T07:00:00.000Z", guardiansAsked: 2, guardiansWaiting: 1 }, entry: entry({ kind: "WITHDRAWN", givenOn: "2026-09-01" }) }),
      ],
    });
    const user = await open();
    const table = await openList(user);
    expect(within(table).getByText("Väntar på 1 av 2 vårdnadshavare")).toBeInTheDocument();
    expect(within(table).getByText(`Tidigare: Återkallat ${day("2026-09-01")}`)).toBeInTheDocument();
  });

  it("says a pupil who has left the class has, and shows the answers behind a row, the latest first", async () => {
    const user = await open();
    const table = await openList(user);
    expect(within(rowOf(table, "Fia Ström")).getByText("Har lämnat klassen")).toBeInTheDocument();
    expect(within(rowOf(table, "Ada Berg")).queryByText("Har lämnat klassen")).not.toBeInTheDocument();
    // Bo was granted and then withdrew: the history holds both, the withdrawal first.
    const toggle = within(rowOf(table, "Bo Ek")).getByRole("button", { name: "Visa historiken för Bo Ek, 2 svar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const history = within(table).getAllByRole("listitem");
    expect(history).toHaveLength(2);
    expect(history[0]).toHaveTextContent(`Återkallat ${day("2026-10-04")}`);
    expect(history[1]).toHaveTextContent(`Samtycke ${day("2026-09-20")}`);
    expect(history[1]).toHaveTextContent("Anteckning: På blanketten");
    await user.click(toggle);
    expect(within(table).queryAllByRole("listitem")).toHaveLength(0);
    // A pupil with no answers has no history to open.
    expect(within(rowOf(table, "Gun Ö")).queryByRole("button", { name: /historiken/ })).not.toBeInTheDocument();
  });

  it("opens a pupil's card from the name", async () => {
    const user = await open();
    const table = await openList(user);
    await user.click(within(rowOf(table, "Ada Berg")).getByRole("button", { name: "Öppna elevkort för Ada Berg" }));
    expect(await screen.findByRole("dialog", { name: "Ada Berg" })).toBeInTheDocument();
    expect(reads(api)).toContain(`${BASE}/students/p-ada`);
  });

  it("goes back to the lists and hands focus back to the list that was opened", async () => {
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Till listorna" }));
    const opener = await screen.findByRole("button", { name: /^Öppna Fotografering HT 2026/ });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("says a list that does not exist, or could not be read", async () => {
    state.fails = { detail: apiError(404, "CHECKLIST_NOT_FOUND") };
    const user = await open();
    await user.click(await screen.findByRole("button", { name: /^Öppna Fotografering HT 2026/ }));
    expect(await screen.findByRole("heading", { name: "Listan finns inte" })).toBeInTheDocument();
  });

  it("reads the list again when it could not be read", async () => {
    state.fails = { detail: apiError(500) };
    const user = await open();
    await user.click(await screen.findByRole("button", { name: /^Öppna Fotografering HT 2026/ }));
    expect(await screen.findByText("Listan kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: /Eleverna och deras svar/ })).toBeInTheDocument();
  });

  it("says a class with nobody in it has no pupils", async () => {
    state.detail = detail({ rows: [] });
    const user = await open();
    await user.click(await screen.findByRole("button", { name: /^Öppna Fotografering HT 2026/ }));
    expect(await screen.findByRole("heading", { name: "Inga elever i listan" })).toBeInTheDocument();
  });
});

describe("choosing pupils", () => {
  it("gives a box only to the pupils the reader may write for", async () => {
    state.detail = detail({ rows: [consentRow("p-a", "Ann A"), consentRow("p-b", "Bea B", { canWrite: false })] });
    const user = await open("teacher");
    const table = await openList(user);
    expect(within(table).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(table).getByRole("checkbox", { name: "Välj Ann A" })).toBeInTheDocument();
  });

  it("chooses everyone, or everyone who has no answer, and clears the choice", async () => {
    const user = await open();
    const table = await openList(user);
    expect(screen.getByText("Välj elever i listan för att skriva in ett svar eller fråga dem.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Välj alla" }));
    expect(within(table).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("7 elever valda")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rensa val" }));
    expect(screen.getByText("Välj elever i listan för att skriva in ett svar eller fråga dem.")).toBeInTheDocument();
    // Fia has left the class and is not asked about: only Gun has no answer.
    await user.click(screen.getByRole("button", { name: "Välj alla som saknar svar" }));
    expect(within(table).getByRole("checkbox", { name: "Välj Gun Ö" })).toBeChecked();
    expect(within(table).getByRole("checkbox", { name: "Välj Fia Ström" })).not.toBeChecked();
    expect(screen.getByText("1 elev vald")).toBeInTheDocument();
  });

  it("keeps the answer buttons off until a pupil is chosen", async () => {
    const user = await open();
    const table = await openList(user);
    for (const name of ["Registrera samtycke", "Registrera nej", "Återkalla samtycke", "Fråga vårdnadshavarna i appen"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    await user.click(within(table).getByRole("checkbox", { name: "Välj Gun Ö" }));
    expect(screen.getByRole("button", { name: "Registrera samtycke" })).toBeEnabled();
  });
});

describe("writing an answer down", () => {
  async function chooseAndOpen(user: ReturnType<typeof userEvent.setup>, button: string, names = ["Gun Ö"]) {
    const table = await openList(user);
    for (const name of names) await user.click(within(table).getByRole("checkbox", { name: `Välj ${name}` }));
    await user.click(screen.getByRole("button", { name: button }));
    return screen.findByRole("dialog", { name: button });
  }

  it("registers a consent with today's date left to the gateway, and says what was written", async () => {
    api.post.mockResolvedValueOnce({ written: 2 });
    const user = await open();
    const dialog = await chooseAndOpen(user, "Registrera samtycke", ["Gun Ö", "Fia Ström"]);
    expect(within(dialog).getByText("Gäller 2 elever.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Datum på blanketten eller i samtalet")).toHaveValue(TODAY);
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/entries`, { studentIds: ["p-gun", "p-fia"], kind: "GRANTED" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findAllByText("Samtycke registrerat för 2 elever.")).not.toHaveLength(0);
    // The list was read again, and the choice is cleared.
    await waitFor(() => expect(reads(api).filter((path) => path === `${BASE}/consent-lists/l-1`).length).toBeGreaterThan(1));
    expect(screen.getByText("Välj elever i listan för att skriva in ett svar eller fråga dem.")).toBeInTheDocument();
  });

  it("keeps the list as it was last read when a read again fails, and says so", async () => {
    api.post.mockResolvedValueOnce({ written: 1 });
    const user = await open();
    const dialog = await chooseAndOpen(user, "Registrera samtycke");
    state.fails = { detail: apiError(500) };
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    expect(await screen.findByText("Listan kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText(/Det som visas är det som senast hämtades/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Eleverna och deras svar/ })).toBeInTheDocument();
  });

  it("registers a no from a day gone by, who gave it and a note", async () => {
    api.post.mockResolvedValueOnce({ written: 1 });
    const user = await open();
    const dialog = await chooseAndOpen(user, "Registrera nej");
    const date = within(dialog).getByLabelText("Datum på blanketten eller i samtalet");
    await user.clear(date);
    await user.type(date, "2026-09-28");
    await user.type(within(dialog).getByLabelText(/Lämnat av/), " Guns pappa ");
    await user.type(within(dialog).getByLabelText(/Anteckning/), " Ringde på måndagen ");
    await user.click(within(dialog).getByRole("button", { name: "Registrera nej" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/entries`, {
        studentIds: ["p-gun"],
        kind: "DECLINED",
        givenOn: "2026-09-28",
        givenBy: "Guns pappa",
        note: "Ringde på måndagen",
      }),
    );
    expect(await screen.findAllByText("Nej registrerat för 1 elev.")).not.toHaveLength(0);
  });

  it("withdraws a consent, and says the earlier one stays in the history", async () => {
    api.post.mockResolvedValueOnce({ written: 1 });
    const user = await open();
    const dialog = await chooseAndOpen(user, "Återkalla samtycke", ["Ada Berg"]);
    expect(within(dialog).getByText(/Det tidigare samtycket finns kvar i historiken/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Datum då samtycket togs tillbaka")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Återkalla samtycke" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/entries`, { studentIds: ["p-ada"], kind: "WITHDRAWN" }));
    expect(await screen.findAllByText("Samtycket är återkallat för 1 elev.")).not.toHaveLength(0);
  });

  it("refuses a day that has not come, and long text, and sends nothing", async () => {
    const user = await open();
    const dialog = await chooseAndOpen(user, "Registrera samtycke");
    const date = within(dialog).getByLabelText("Datum på blanketten eller i samtalet");
    await user.clear(date);
    await user.type(date, TOMORROW);
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    expect(await within(dialog).findByText("Dagen har inte kommit.")).toBeInTheDocument();
    expect(date).toHaveFocus();
    await user.clear(date);
    await user.type(date, TODAY);
    await user.click(within(dialog).getByLabelText(/Lämnat av/));
    await user.paste("g".repeat(121));
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    expect(await within(dialog).findByText("Högst 120 tecken.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/Lämnat av/));
    await user.click(within(dialog).getByLabelText(/Anteckning/));
    await user.paste("n".repeat(301));
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    expect(await within(dialog).findByText("Anteckningen får vara högst 300 tecken.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says a list that has ended takes no more, with the dialog left open", async () => {
    api.post.mockRejectedValueOnce(apiError(409, "CONSENT_LIST_CLOSED"));
    const user = await open();
    const dialog = await chooseAndOpen(user, "Registrera samtycke");
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    expect(await within(dialog).findByText("Listan är avslutad. Det går inte att skriva mer i den.")).toBeInTheDocument();
    expect(within(dialog).getByText("Svaret kunde inte skrivas in")).toBeInTheDocument();
  });

  it("says a teacher may only write for their mentees", async () => {
    api.post.mockRejectedValueOnce(apiError(403, "CHECKLIST_NOT_YOUR_PUPIL"));
    const user = await open("teacher");
    const dialog = await chooseAndOpen(user, "Registrera samtycke");
    await user.click(within(dialog).getByRole("button", { name: "Registrera samtycke" }));
    expect(await within(dialog).findByText(/skriva in samtycken för dina mentorselever/)).toBeInTheDocument();
  });

  it("closes on Avbryt without writing", async () => {
    const user = await open();
    const dialog = await chooseAndOpen(user, "Registrera samtycke");
    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("asking the guardians in the app", () => {
  it("asks the chosen pupils once the question is answered, and says who was asked and who could not be", async () => {
    api.post.mockResolvedValueOnce({ requestId: "r-1", pupils: 1, guardians: 2, withoutGuardian: ["p-fia"] });
    const user = await open();
    const table = await openList(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Gun Ö" }));
    await user.click(screen.getByRole("button", { name: "Fråga vårdnadshavarna i appen" }));
    const dialog = await screen.findByRole("dialog", { name: "Fråga vårdnadshavarna i appen?" });
    expect(within(dialog).getByText("1 vald elev.")).toBeInTheDocument();
    expect(within(dialog).getByText(/bekräftar med ett tryck under Meddelanden/)).toBeInTheDocument();
    expect(within(dialog).getByText(/går inte att ta tillbaka/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Fråga vårdnadshavarna" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/ask`, { studentIds: ["p-gun"] }));
    expect(
      await screen.findAllByText("Frågade 2 vårdnadshavare om 1 elev. 1 elev har ingen vårdnadshavare att fråga: Fia Ström."),
    ).not.toHaveLength(0);
  });

  it("asks everyone who has no answer with no pupils in the body", async () => {
    api.post.mockResolvedValueOnce({ requestId: "r-2", pupils: 1, guardians: 2, withoutGuardian: [] });
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Fråga alla som saknar svar" }));
    const dialog = await screen.findByRole("dialog", { name: "Fråga vårdnadshavarna i appen?" });
    expect(within(dialog).getByText("Alla elever som saknar svar: 1.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Fråga vårdnadshavarna" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/ask`, {}));
    expect(await screen.findAllByText("Frågade 2 vårdnadshavare om 1 elev.")).not.toHaveLength(0);
  });

  it("will not ask everyone when nobody is without an answer", async () => {
    state.detail = detail({ rows: [consentRow("p-a", "Ann A", { state: "GRANTED", entry: entry() })] });
    const user = await open();
    await openList(user);
    expect(screen.getByRole("button", { name: "Fråga alla som saknar svar" })).toBeDisabled();
  });

  it("explains how the guardian confirms, and that the consent is then written by itself", async () => {
    const user = await open();
    await openList(user);
    expect(screen.getByText(/skrivs samtycket in här av sig självt/)).toBeInTheDocument();
  });

  it("says the school has not turned Kvittens on, and who can, and offers no question", async () => {
    state.detail = detail({ kvittens: false });
    const user = await open();
    await openList(user);
    expect(screen.getByText("Skolan har inte slagit på Kvittens")).toBeInTheDocument();
    expect(screen.getByText(/Slå på Kvittens på sidan Kvittens/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fråga vårdnadshavarna i appen" })).not.toBeInTheDocument();
    // Answers from a paper are still written down.
    expect(screen.getByRole("button", { name: "Registrera samtycke" })).toBeInTheDocument();
  });

  it("tells a teacher that an administrator turns Kvittens on", async () => {
    state.detail = detail({ kvittens: false });
    const user = await open("teacher");
    await openList(user);
    expect(screen.getByText(/En administratör kan slå på Kvittens/)).toBeInTheDocument();
  });

  it.each([
    ["ACK_DISABLED", 409, "Skolan har inte slagit på Kvittens, så det går inte att fråga vårdnadshavarna i appen."],
    ["CONSENT_NOBODY_TO_ASK", 422, "Det finns ingen att fråga: ingen av eleverna har en vårdnadshavare, eller så har alla redan svarat."],
    ["ACK_NO_GUARDIANS", 422, "Ingen av eleverna har en vårdnadshavare att fråga."],
    ["ACK_TOO_MANY_REQUESTS", 429, "Du har redan skickat tio frågor den senaste timmen. Vänta en stund och försök igen."],
    ["ACK_TOO_MANY_RECIPIENTS", 429, "Skolan har bett om kvittens från för många vårdnadshavare det senaste dygnet. Försök igen i morgon."],
    ["CONSENT_LIST_CLOSED", 409, "Listan är avslutad. Det går inte att skriva mer i den."],
  ])("says %s in a sentence, with the question left open", async (code, status, sentence) => {
    api.post.mockRejectedValueOnce(apiError(status, code));
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Fråga alla som saknar svar" }));
    const dialog = await screen.findByRole("dialog", { name: "Fråga vårdnadshavarna i appen?" });
    await user.click(within(dialog).getByRole("button", { name: "Fråga vårdnadshavarna" }));
    expect(await within(dialog).findByText(sentence)).toBeInTheDocument();
    expect(within(dialog).getByText("Frågan kunde inte skickas")).toBeInTheDocument();
  });

  it("says the gateway's throttle (five a minute) is a wait", async () => {
    api.post.mockRejectedValueOnce(apiError(429, undefined, "ThrottlerException"));
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Fråga alla som saknar svar" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Fråga vårdnadshavarna" }));
    expect(await within(dialog).findByText("Du gör det för ofta. Vänta en minut och försök igen.")).toBeInTheDocument();
  });

  it("closes the question on Avbryt without asking", async () => {
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Fråga alla som saknar svar" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("ending a list", () => {
  it("asks first, says what an ended list is, and ends it with no body", async () => {
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Avsluta listan" }));
    const dialog = await screen.findByRole("dialog", { name: "Avsluta Fotografering HT 2026?" });
    expect(within(dialog).getByText(/tar inga fler svar/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Det som redan är skrivet står kvar/)).toBeInTheDocument();
    expect(within(dialog).getByText(/En vårdnadshavare som bekräftar en fråga efter att listan har avslutats ger inget svar/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Avsluta listan" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/close`));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findAllByText("Listan är avslutad.")).not.toHaveLength(0);
  });

  it("says why it could not be ended, with the question left open", async () => {
    api.post.mockRejectedValueOnce(apiError(404, "CHECKLIST_NOT_FOUND"));
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Avsluta listan" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Avsluta listan" }));
    expect(await within(dialog).findByText("Det finns inte längre, eller är inte ditt att se. Ladda om sidan.")).toBeInTheDocument();
    expect(within(dialog).getByText("Listan kunde inte avslutas")).toBeInTheDocument();
  });

  it("closes the question on Avbryt without ending", async () => {
    const user = await open();
    await openList(user);
    await user.click(screen.getByRole("button", { name: "Avsluta listan" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("is the maker's or an administrator's: a reader who may not end it has no button", async () => {
    state.detail = detail({ canClose: false });
    const user = await open("teacher");
    await openList(user);
    expect(screen.queryByRole("button", { name: "Avsluta listan" })).not.toBeInTheDocument();
  });

  it("offers to end a list that has no pupil to write for", async () => {
    state.detail = detail({ rows: [consentRow("p-a", "Ann A", { canWrite: false })] });
    const user = await open();
    await openList(user);
    expect(screen.getByRole("button", { name: "Avsluta listan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrera samtycke" })).not.toBeInTheDocument();
  });

  it("takes no answers once ended: the list reads, with no box and no button, and says it has ended", async () => {
    state.detail = detail({
      list: { ...detail().list, closedAt: "2026-10-20T10:00:00.000Z" },
      rows: CONSENT_ROWS.map((one) => ({ ...one, canWrite: false })),
    });
    const user = await open();
    const table = await openList(user);
    expect(screen.getByText("Listan är avslutad")).toBeInTheDocument();
    expect(screen.getByText(/En avslutad lista tar inga fler svar/)).toBeInTheDocument();
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    for (const name of ["Registrera samtycke", "Avsluta listan", "Fråga vårdnadshavarna i appen"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("is read-only for a läsare: the list reads and nothing can be written, asked or ended", async () => {
    profile.readOnly = true;
    const user = await open();
    const table = await openList(user);
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    for (const name of ["Registrera samtycke", "Avsluta listan", "Fråga vårdnadshavarna i appen", "Välj alla"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

describe("in English", () => {
  it("has the same screens in the other language", async () => {
    const user = userEvent.setup();
    renderChecklists(<Checklists audience="admin" />, "en");
    await user.click(screen.getByRole("tab", { name: "Consents" }));
    await user.click(await screen.findByRole("button", { name: /^Open Fotografering HT 2026/ }));
    const table = await screen.findByRole("table", { name: /The pupils and their answers/ });
    expect(within(table).getByText("Withdrawn")).toBeInTheDocument();
    expect(within(table).getByText("Asked in the app")).toBeInTheDocument();
    expect(within(table).getByText("Waiting for 1 of 2 guardians")).toBeInTheDocument();
    expect(counts().pupils).toBe(7);
    expect(GROUPS).toHaveLength(3);
  });
});
