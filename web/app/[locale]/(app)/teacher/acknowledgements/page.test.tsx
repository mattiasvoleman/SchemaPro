import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { PUPILS, SETTINGS_OFF, SETTINGS_ON, detail, guardian, listItem, pupilRow } from "@/lib/__fixtures__/ack";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import TeacherAcknowledgementsPage from "./page";

/**
 * /teacher/acknowledgements: the teacher's requests for a guardian's
 * confirmation, a new request about the pupils they mentor, and one request
 * with who confirmed it and when — through the gateway's routes and the real
 * Swedish messages (a key missing from sv.json throws here).
 *
 * What this guards: the pupils and a request are read when they are opened and
 * not before (the gateway records each reading); a form that cannot be sent
 * says why and sends nothing; the sender is told how many guardians will be
 * asked and which pupils nobody can be asked about; a refusal is said in the
 * form with everything typed still there; and the request shows each pupil as
 * done, waiting or without anyone who can confirm, and each guardian as
 * confirmed (and when), waiting, or no longer a guardian.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => false }));

const BASE = "/api/v1/acknowledgements";

const state = vi.hoisted(() => ({
  settings: undefined as unknown,
  list: [] as unknown[],
  pupils: [] as unknown[],
  detail: undefined as unknown,
  listError: false,
  pupilsError: false,
  detailError: null as null | Error,
}));

const day = (iso: string) => new Intl.DateTimeFormat("sv", { dateStyle: "medium" }).format(new Date(iso));
const moment = (iso: string) => new Intl.DateTimeFormat("sv", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <TeacherAcknowledgementsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const reads = () => api.get.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = SETTINGS_ON;
  state.list = [listItem()];
  state.pupils = PUPILS;
  state.detail = detail();
  state.listError = false;
  state.pupilsError = false;
  state.detailError = null;
  api.get.mockImplementation(async (path: string) => {
    if (path === `${BASE}/settings`) return state.settings;
    if (path === BASE) {
      if (state.listError) throw new ApiError(500, "boom");
      return state.list;
    }
    if (path === `${BASE}/pupils`) {
      if (state.pupilsError) throw new ApiError(500, "boom");
      return state.pupils;
    }
    if (path.startsWith(`${BASE}/`)) {
      if (state.detailError) throw state.detailError;
      return state.detail;
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.post.mockResolvedValue({ id: "r-new", pupils: 2, guardians: 3, withoutGuardian: [] });
});

const newButton = () => screen.findByRole("button", { name: "Be om kvittens" });

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await newButton());
  return screen.findByRole("heading", { level: 2, name: "Ny förfrågan" });
}

describe("the teacher's list", () => {
  it("is headed Kvittens, reads the setting and the list, and no pupil or request until asked", async () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Kvittens" })).toBeInTheDocument();
    expect(screen.getByText("Be vårdnadshavarna till dina mentorselever bekräfta ett meddelande")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
    expect(reads().sort()).toEqual([BASE, `${BASE}/settings`].sort());
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("lists each request with its rule, how many pupils are done, who still waits and what became of the reminder", async () => {
    state.list = [
      listItem({ id: "r-1", title: "Utflykten på torsdag", rule: "ANY", pupils: 3, met: 1, waiting: 4 }),
      listItem({ id: "r-2", title: "Beslutet om ledighet", rule: "ALL", pupils: 2, met: 2, waiting: 0, remindAt: "2026-11-04T08:30:00.000Z", reminderSent: true }),
      listItem({ id: "r-3", title: "Larmet", pupils: 1, met: 1, waiting: 0, remindAt: "2026-11-07T08:30:00.000Z" }),
      listItem({ id: "r-4", title: "Skolfotot", pupils: 1, met: 0, waiting: 2, remindAt: null }),
    ];
    renderPage();

    const table = await screen.findByRole("table", { name: "Förfrågningar om kvittens" });
    const rows = within(table).getAllByRole("row").slice(1);
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell");
    expect(rows).toHaveLength(4);
    expect(cells(rows[0]!)[0]).toHaveTextContent(`Utflykten på torsdagSkickad ${day("2026-11-05T08:30:00.000Z")} av Anna Lind`);
    expect(cells(rows[0]!).slice(1).map((cell) => cell.textContent)).toEqual([
      "En räcker",
      "1 av 3 elever",
      "4 vårdnadshavare",
      `Går ${day("2026-11-07T08:30:00.000Z")}`,
    ]);
    // Every pupil done: said so, and nobody waits. The reminder went out.
    expect(cells(rows[1]!).slice(1).map((cell) => cell.textContent)).toEqual(["Alla", "2 av 2 eleverAlla klara", "Ingen", "Skickad"]);
    // Nobody waits, so the reminder that is due will not go.
    expect(cells(rows[2]!)[4]).toHaveTextContent("Behövs inte");
    // The school sets no reminder.
    expect(cells(rows[3]!)[4]).toHaveTextContent("Ingen");
    expect(cells(rows[3]!)[3]).toHaveTextContent("2 vårdnadshavare");
  });

  it("welcomes an empty list, and says a failed one as such", async () => {
    state.list = [];
    const { unmount } = renderPage();
    expect(await screen.findByText("Inga förfrågningar ännu")).toBeInTheDocument();
    expect(screen.getByText(/När du ber vårdnadshavare bekräfta ett meddelande syns det här/)).toBeInTheDocument();
    unmount();

    state.listError = true;
    renderPage();
    expect(await screen.findByText("Förfrågningarna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Inga förfrågningar ännu")).not.toBeInTheDocument();
  });

  it("says that the school has not turned Kvittens on and offers no button, but keeps the earlier requests", async () => {
    state.settings = SETTINGS_OFF;
    renderPage();

    expect(await screen.findByText("Skolan har inte slagit på kvittens")).toBeInTheDocument();
    expect(screen.getByText("En administratör kan slå på den. Tidigare förfrågningar finns kvar nedan.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Be om kvittens" })).not.toBeInTheDocument();
  });
});

describe("a new request", () => {
  it("reads the pupils only now, takes focus to its heading and shows how many guardians each would ask", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Utflykten på torsdag" });
    expect(reads()).not.toContain(`${BASE}/pupils`);

    const heading = await openForm(user);

    expect(reads().filter((path) => path === `${BASE}/pupils`)).toHaveLength(1);
    await waitFor(() => expect(heading).toHaveFocus());
    expect(await screen.findByRole("checkbox", { name: /Ada Berg/ })).toHaveAccessibleName(/2 vårdnadshavare/);
    expect(screen.getByRole("checkbox", { name: /Bo Ek/ })).toHaveAccessibleName(/1 vårdnadshavare/);
    expect(screen.getByRole("checkbox", { name: /Cia Lund/ })).toHaveAccessibleName(/Ingen vårdnadshavare/);
    expect(screen.getByText("4 av 4 elever visas")).toBeInTheDocument();
    // One guardian is enough unless the sender says otherwise.
    expect(screen.getByRole("radio", { name: "Räcker att en vårdnadshavare bekräftar" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Alla vårdnadshavare ska bekräfta" })).not.toBeChecked();
    expect(screen.getByText("Ingen elev vald. Ingen vårdnadshavare att fråga.")).toBeInTheDocument();
  });

  it("says what is missing and sends nothing, with focus on the first field that lacks something", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await screen.findByRole("checkbox", { name: /Ada Berg/ });

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));

    expect(screen.getByText("Skriv en rubrik.")).toBeInTheDocument();
    expect(screen.getByText("Skriv ett meddelande.")).toBeInTheDocument();
    expect(screen.getByText("Välj minst en elev.")).toBeInTheDocument();
    expect(screen.getByLabelText("Rubrik")).toBeInvalid();
    expect(screen.getByLabelText("Rubrik")).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("counts the text and refuses a title or a text that is too long, without cutting it", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await screen.findByRole("checkbox", { name: /Ada Berg/ });

    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("x".repeat(121));
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("y".repeat(2001));
    expect(screen.getByText(/121 av 120 tecken/)).toBeInTheDocument();
    expect(screen.getByText(/2\s001 av 2\s000 tecken/)).toBeInTheDocument();
    expect(screen.getByLabelText("Rubrik")).toHaveValue("x".repeat(121));

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));
    expect(screen.getByText("Rubriken får vara högst 120 tecken.")).toBeInTheDocument();
    expect(screen.getByText(/Meddelandet får vara högst 2\s000 tecken\./)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("chooses a whole class at once, says how many guardians will be asked and turns the button round", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await screen.findByRole("checkbox", { name: /Ada Berg/ });

    await user.selectOptions(screen.getByLabelText("Klass"), "7A");
    expect(screen.getByText("2 av 4 elever visas")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Dan Dal/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Markera alla i 7A" }));

    expect(screen.getByRole("checkbox", { name: /Ada Berg/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Bo Ek/ })).toBeChecked();
    expect(screen.getByText("2 elever valda. 3 vårdnadshavare får frågan.")).toBeInTheDocument();

    // The choice stays when the class shown changes; the button now clears that class only.
    await user.selectOptions(screen.getByLabelText("Klass"), "7B");
    expect(screen.getByRole("button", { name: "Markera alla i 7B" })).toBeInTheDocument();
    expect(screen.getByText("2 elever valda. 3 vårdnadshavare får frågan.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Klass"), "7A");
    await user.click(screen.getByRole("button", { name: "Avmarkera alla i 7A" }));
    expect(screen.getByText("Ingen elev vald. Ingen vårdnadshavare att fråga.")).toBeInTheDocument();
  });

  it("searches by name or class, and a search is not a class: the button says what it will choose", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await screen.findByRole("checkbox", { name: /Ada Berg/ });

    await user.type(screen.getByLabelText("Sök elev eller klass"), "lund");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: /Cia Lund/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Markera alla som visas" }));
    expect(screen.getByRole("button", { name: "Avmarkera alla som visas" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Sök elev eller klass"));
    await user.type(screen.getByLabelText("Sök elev eller klass"), "ingen sådan");
    expect(screen.getByText("Ingen elev matchar sökningen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Markera alla som visas" })).toBeDisabled();
  });

  it("does not send on Enter in the search field or the title: only the button sends", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await screen.findByRole("checkbox", { name: /Ada Berg/ });
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("På torsdag");
    await user.click(screen.getByRole("checkbox", { name: /Ada Berg/ }));

    await user.type(screen.getByLabelText("Sök elev eller klass"), "ada{Enter}");
    await user.type(screen.getByLabelText("Rubrik"), "{Enter}");

    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByText("Skriv en rubrik.")).not.toBeInTheDocument();
  });

  it("warns about the chosen pupils nobody can be asked about, and sends the rest", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await user.click(await screen.findByRole("checkbox", { name: /Ada Berg/ }));
    await user.click(screen.getByRole("checkbox", { name: /Cia Lund/ }));

    const warning = screen.getByText("1 vald elev har ingen vårdnadshavare att fråga");
    expect(warning.closest("[data-tone]")).toHaveTextContent("De lämnas utanför förfrågan: Cia Lund.");
    expect(screen.getByText("2 elever valda. 2 vårdnadshavare får frågan.")).toBeInTheDocument();
  });

  it("stops a request whose chosen pupils have no guardian at all, as the gateway would (422)", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await user.click(await screen.findByRole("checkbox", { name: /Cia Lund/ }));
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("På torsdag");

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));

    expect(screen.getByText("Ingen av de valda eleverna har en vårdnadshavare att fråga.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("sends the trimmed title and text, the rule and the pupils, then says how many were asked in a live region and a notice, and reads the list again", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await screen.findByRole("checkbox", { name: /Ada Berg/ });
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("  Beslutet om ledighet ");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("Beslutet finns i appen.\nLäs det.");
    await user.click(screen.getByRole("radio", { name: "Alla vårdnadshavare ska bekräfta" }));
    await user.selectOptions(screen.getByLabelText("Klass"), "7A");
    await user.click(screen.getByRole("button", { name: "Markera alla i 7A" }));
    const before = reads().filter((path) => path === BASE).length;

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(BASE, {
        title: "Beslutet om ledighet",
        body: "Beslutet finns i appen.\nLäs det.",
        rule: "ALL",
        studentIds: ["p-ada", "p-bo"],
      }),
    );
    expect(api.post).toHaveBeenCalledTimes(1);
    const notice = (await screen.findByText("Förfrågan är skickad", { selector: "p" })).closest("[data-tone]")!;
    expect(notice).toHaveTextContent("Förfrågan gick till 3 vårdnadshavare för 2 elever.");
    expect(screen.getAllByRole("status").map((one) => one.textContent).join(" ")).toContain("Förfrågan gick till 3 vårdnadshavare för 2 elever.");
    // Back on the list, with focus on its heading, and the list read again.
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Förfrågningar" })).toHaveFocus());
    await waitFor(() => expect(reads().filter((path) => path === BASE).length).toBeGreaterThan(before));
    expect(screen.queryByLabelText("Rubrik")).not.toBeInTheDocument();
  });

  it("names the pupils the gateway left out because nobody could be asked about them", async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ id: "r-new", pupils: 1, guardians: 2, withoutGuardian: ["p-cia"] });
    renderPage();
    await openForm(user);
    await user.click(await screen.findByRole("checkbox", { name: /Ada Berg/ }));
    await user.click(screen.getByRole("checkbox", { name: /Cia Lund/ }));
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("På torsdag");

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));

    const notice = (await screen.findByText("Förfrågan är skickad", { selector: "p" })).closest("[data-tone]")!;
    expect(notice).toHaveTextContent("1 elev lämnades utanför eftersom ingen vårdnadshavare kunde frågas: Cia Lund.");
  });

  it("closes the form while it is sent and sends once however often the button is pressed", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    api.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: "r-new", pupils: 1, guardians: 2, withoutGuardian: [] });
        }),
    );
    renderPage();
    await openForm(user);
    await user.click(await screen.findByRole("checkbox", { name: /Ada Berg/ }));
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("På torsdag");

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));
    const sending = await screen.findByRole("button", { name: "Skickar…" });
    expect(sending).toBeDisabled();
    expect(screen.getByLabelText("Rubrik")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Avbryt" })).toBeDisabled();
    await user.click(sending);
    expect(api.post).toHaveBeenCalledTimes(1);

    release();
    expect(await screen.findByText("Förfrågan är skickad", { selector: "p" })).toBeInTheDocument();
  });

  it.each([
    ["ACK_DISABLED", 409, "Skolan har inte slagit på kvittens. Be en administratör att slå på den."],
    ["ACK_NOT_YOUR_PUPIL", 403, "Du kan bara be om kvittens för elever du är mentor för."],
    ["ACK_NO_GUARDIANS", 422, "Ingen av eleverna har en vårdnadshavare att fråga."],
    ["ACK_UNKNOWN_PUPIL", 422, "En av eleverna finns inte längre på skolan. Elevlistan är uppdaterad: kontrollera dina val och försök igen."],
  ])("says a refusal (%s) in the form, in Swedish, with everything typed and chosen still there", async (code, status, sentence) => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new ApiError(status, "English prose for a log.", code));
    renderPage();
    await openForm(user);
    await user.click(await screen.findByRole("checkbox", { name: /Ada Berg/ }));
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("På torsdag");
    const pupilReads = reads().filter((path) => path === `${BASE}/pupils`).length;

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent("Förfrågan skickades inte");
    expect(refusal).toHaveTextContent(sentence);
    expect(refusal).not.toHaveTextContent(/English prose|ACK_/);
    expect(screen.getByLabelText("Rubrik")).toHaveValue("Utflykten");
    expect(screen.getByLabelText("Meddelande")).toHaveValue("På torsdag");
    expect(screen.getByRole("checkbox", { name: /Ada Berg/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Skicka förfrågan" })).toBeEnabled();
    // A pupil who has left: the list is read again, and the choice is made from what is there now.
    if (code === "ACK_UNKNOWN_PUPIL") await waitFor(() => expect(reads().filter((path) => path === `${BASE}/pupils`).length).toBe(pupilReads + 1));
  });

  it("says a refusal it has no sentence for with the gateway's own words", async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new ApiError(500, "Något gick fel hos servern."));
    renderPage();
    await openForm(user);
    await user.click(await screen.findByRole("checkbox", { name: /Ada Berg/ }));
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");
    await user.click(screen.getByLabelText("Meddelande"));
    await user.paste("På torsdag");

    await user.click(screen.getByRole("button", { name: "Skicka förfrågan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Något gick fel hos servern.");
  });

  it("goes back to the list with focus on the button that opened the form, and keeps nothing of what was typed", async () => {
    const user = userEvent.setup();
    renderPage();
    await openForm(user);
    await user.click(screen.getByLabelText("Rubrik"));
    await user.paste("Utflykten");

    await user.click(screen.getByRole("button", { name: "Avbryt" }));

    const button = await newButton();
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.queryByText("Förfrågan är skickad")).not.toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByLabelText("Rubrik")).toHaveValue("");
  });

  it("says a pupil list that cannot be read as such, and reads it again when asked", async () => {
    const user = userEvent.setup();
    state.pupilsError = true;
    renderPage();
    await openForm(user);

    expect(await screen.findByText("Eleverna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText("Inget har skickats. Försök igen om en stund.")).toBeInTheDocument();
    state.pupilsError = false;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("checkbox", { name: /Ada Berg/ })).toBeInTheDocument();
  });

  it("tells a teacher who mentors nobody so, instead of an empty list", async () => {
    const user = userEvent.setup();
    state.pupils = [];
    renderPage();
    await openForm(user);

    expect(await screen.findByText("Du är inte mentor för några elever just nu")).toBeInTheDocument();
    expect(screen.getByText("Kvittens går till vårdnadshavarna till elever du är mentor för.")).toBeInTheDocument();
  });
});

describe("one request", () => {
  async function openRequest(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Utflykten på torsdag" }));
    return screen.findByRole("heading", { level: 2, name: "Utflykten på torsdag" });
  }

  it("reads the request by its id only when it is opened and shows the text, the rule, when it was sent and the reminder", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Utflykten på torsdag" });
    expect(reads()).not.toContain(`${BASE}/r-1`);

    const heading = await openRequest(user);

    expect(reads()).toContain(`${BASE}/r-1`);
    await waitFor(() => expect(heading).toHaveFocus());
    const text = await screen.findByText(/Vi åker kl 8\./);
    expect(text.textContent).toBe("Vi åker kl 8.\nTa med matsäck.");
    const section = screen.getByRole("region", { name: "Utflykten på torsdag" });
    expect(section).toHaveTextContent("Räcker att en vårdnadshavare bekräftar");
    expect(section).toHaveTextContent(`${moment("2026-11-05T08:30:00.000Z")} av Anna Lind`);
    expect(section).toHaveTextContent(`Skickas ${moment("2026-11-07T08:30:00.000Z")} till dem som då inte har bekräftat`);
    expect(screen.getByText("1 av 3 elever klara")).toBeInTheDocument();
  });

  it("shows each pupil as done, waiting or without anyone who can confirm, and each guardian as confirmed with the time, waiting, or no longer a guardian", async () => {
    const user = userEvent.setup();
    renderPage();
    await openRequest(user);

    const ada = (await screen.findByText("Ada Berg")).closest("li")!;
    expect(ada).toHaveTextContent("7A");
    expect(within(ada).getByText("Klar")).toBeInTheDocument();
    expect(ada).toHaveTextContent(`Sara BergBekräftade ${moment("2026-11-05T09:12:00.000Z")}`);
    expect(ada).toHaveTextContent("Tom BergVäntar");
    const bo = screen.getByText("Bo Ek").closest("li")!;
    expect(within(bo).getByText("Väntar", { selector: "div" })).toBeInTheDocument();
    const dan = screen.getByText("Dan Dal").closest("li")!;
    expect(within(dan).getByText("Ingen kan bekräfta")).toBeInTheDocument();
    expect(dan).toHaveTextContent("Ola DalVårdnaden har upphört");
  });

  it("says when each guardian was reminded and that the reminder went out", async () => {
    const user = userEvent.setup();
    state.detail = detail({
      remindAt: "2026-11-07T08:30:00.000Z",
      reminderSentAt: "2026-11-07T08:31:00.000Z",
      pupils: [pupilRow("p-bo", "Bo Ek", [guardian("g-eva", "Eva Ek", "WAITING", { remindedAt: "2026-11-07T08:31:00.000Z" })])],
    });
    renderPage();
    await openRequest(user);

    expect(await screen.findByText(`Skickad ${moment("2026-11-07T08:31:00.000Z")}`)).toBeInTheDocument();
    expect(screen.getByText("Bo Ek").closest("li")).toHaveTextContent(`Eva EkVäntar · Påmind ${moment("2026-11-07T08:31:00.000Z")}`);
  });

  it("says there is no reminder when the school sets none", async () => {
    const user = userEvent.setup();
    state.detail = detail({ remindAt: null, reminderSentAt: null });
    renderPage();
    await openRequest(user);

    expect(await screen.findByText("Ingen påminnelse")).toBeInTheDocument();
  });

  it("can show only the pupils who are not done, and says so when there are none", async () => {
    const user = userEvent.setup();
    renderPage();
    await openRequest(user);
    await screen.findByText("Ada Berg");

    await user.click(screen.getByRole("switch", { name: "Visa bara elever som inte är klara" }));
    expect(screen.queryByText("Ada Berg")).not.toBeInTheDocument();
    expect(screen.getByText("Bo Ek")).toBeInTheDocument();
    expect(screen.getByText("Dan Dal")).toBeInTheDocument();
  });

  it("says every pupil is done when none is left to show", async () => {
    const user = userEvent.setup();
    state.detail = detail({ pupils: [pupilRow("p-ada", "Ada Berg", [guardian("g-sara", "Sara Berg", "CONFIRMED")])] });
    renderPage();
    await openRequest(user);
    await screen.findByText("Ada Berg");

    await user.click(screen.getByRole("switch", { name: "Visa bara elever som inte är klara" }));

    expect(screen.getByRole("status")).toHaveTextContent("Alla elever är klara.");
  });

  it("goes back to the list with focus on the request that was opened", async () => {
    const user = userEvent.setup();
    renderPage();
    await openRequest(user);
    await screen.findByText("Ada Berg");

    await user.click(screen.getByRole("button", { name: "Till förfrågningarna" }));

    const opener = await screen.findByRole("button", { name: "Utflykten på torsdag" });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByText("Ada Berg")).not.toBeInTheDocument();
  });

  it("reads it again each time it is opened, since the reading is recorded", async () => {
    const user = userEvent.setup();
    renderPage();
    await openRequest(user);
    await screen.findByText("Ada Berg");
    await user.click(screen.getByRole("button", { name: "Till förfrågningarna" }));
    await user.click(await screen.findByRole("button", { name: "Utflykten på torsdag" }));
    await screen.findByText("Ada Berg");

    expect(reads().filter((path) => path === `${BASE}/r-1`)).toHaveLength(2);
  });

  it("says a request that is gone, or not about the teacher's pupils, as that and a failed read as a failure", async () => {
    const user = userEvent.setup();
    state.detailError = new ApiError(404, "Meddelandet finns inte.", "ACK_NOT_FOUND");
    renderPage();
    await openRequest(user);
    expect(await screen.findByText("Förfrågan finns inte")).toBeInTheDocument();
    expect(screen.getByText("Den kan ha tagits bort, eller så gäller den inga av dina elever.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Till förfrågningarna" }));
    state.detailError = new ApiError(500, "boom");
    await user.click(await screen.findByRole("button", { name: "Utflykten på torsdag" }));
    expect(await screen.findByText("Förfrågan kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Förfrågan finns inte")).not.toBeInTheDocument();
  });
});

describe("English", () => {
  it("speaks English too", async () => {
    const user = userEvent.setup();
    renderPage("en");

    expect(await screen.findByRole("heading", { level: 1, name: "Acknowledgements" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Utflykten på torsdag" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 pupils")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ask for acknowledgement" }));
    expect(await screen.findByRole("radio", { name: "All guardians must confirm" })).toBeInTheDocument();
    expect(await screen.findByText("No pupil chosen. No guardian to ask.")).toBeInTheDocument();
  });
});
