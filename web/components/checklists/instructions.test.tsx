import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, toDateString } from "@/lib/utils";
import { ROWS, TEMPLATES, card, proof, roster, row, template } from "@/lib/__fixtures__/checklists";
import { BASE, apiError, installApi, reads, renderChecklists, scenario, subjectsClient, warmChecklists, type Scenario } from "@/lib/__fixtures__/checklists-render";
import { Checklists } from "./checklists";

/**
 * Instruktionsbevis, as the administrator and the teacher have it: the
 * templates (the administrator's), and Bocka av: a template and a group, the
 * roster, the tick with its date, instructor and note, voiding a tick with a
 * reason, and a pupil's card. Through the gateway's routes and the real Swedish
 * messages (a key missing from sv.json throws here).
 *
 * What this guards: nothing about pupils is read until a template and a group
 * are chosen; a tick is sent with exactly what the form says (today left to the
 * gateway's clock); a voided tick says why and stays visible on the card; and a
 * refusal is said in a sentence, in the form, with everything typed still there.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
const profile = vi.hoisted(() => ({ readOnly: false }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => profile.readOnly }));
const supabase = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => supabase.client }));

const day = (iso: string) => new Intl.DateTimeFormat("sv", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const TODAY = toDateString(new Date());
const TOMORROW = toDateString(addDays(new Date(), 1));

let state: Scenario;

// The dialogs are fetched on the first click (use-dialogs.tsx): load them once, so that no test pays for the module's first transform.
beforeAll(() => warmChecklists(), 120_000);

// userEvent keeps its default pause between actions: a dialog sets `pointer-events: none` on the page while it opens and `auto` on itself one
// render later, and a user that acts with no pause at all can reach the dialog's field in between (on a slow machine it does).

beforeEach(() => {
  vi.clearAllMocks();
  profile.readOnly = false;
  state = scenario();
  installApi(api, state);
  api.post.mockResolvedValue({});
  api.patch.mockResolvedValue(template());
  supabase.client = subjectsClient([
    { id: "s-no", name: "Naturorienterande ämnen" },
    { id: "s-slojd", name: "Slöjd" },
  ]);
});

const open = async (audience: "admin" | "teacher" = "admin") => {
  const user = userEvent.setup();
  renderChecklists(<Checklists audience={audience} />);
  return user;
};

async function chooseRoster(user: ReturnType<typeof userEvent.setup>, templateId = "t-1", groupId = "g-7a") {
  await user.selectOptions(await screen.findByLabelText("Mall"), templateId);
  await user.selectOptions(screen.getByLabelText("Grupp"), groupId);
  return screen.findByRole("table", { name: /Eleverna i/ });
}

describe("the templates (the administrator's)", () => {
  it("lists the school's templates with their subject and description, and marks the retired one", async () => {
    await open();
    const card = await screen.findByRole("region", { name: "Mallar" });
    const items = await within(card).findAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[0]!).getByText("Maskinerna")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Slöjd")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Skyddsglasögon och dragskåp.")).toBeInTheDocument();
    // A moment with no subject says so.
    expect(within(items[2]!).getByText("Inget ämne")).toBeInTheDocument();
    expect(within(items[3]!).getByText("Avvecklad")).toBeInTheDocument();
    expect(within(items[0]!).queryByText("Avvecklad")).not.toBeInTheDocument();
    // A template is never deleted, and the card says so.
    expect(within(card).getByText(/tas aldrig bort/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Ta bort/ })).not.toBeInTheDocument();
    expect(reads(api)).toContain(`${BASE}/templates?includeRetired=true`);
  });

  it("makes a template of a moment and a subject, sends the trimmed text, and reads the templates again", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny mall" }));
    await user.type(screen.getByLabelText("Moment"), "  Bandsågen ");
    await user.selectOptions(screen.getByLabelText(/Ämne/), "s-slojd");
    await user.type(screen.getByLabelText(/Beskrivning/), " Bara med handledare ");
    const before = reads(api).filter((path) => path.startsWith(`${BASE}/templates?`)).length;
    await user.click(screen.getByRole("button", { name: "Skapa mallen" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`${BASE}/templates`, { title: "Bandsågen", description: "Bara med handledare", subjectId: "s-slojd" }),
    );
    // The form is gone and the list was read again.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Skapa mallen" })).not.toBeInTheDocument());
    expect(reads(api).filter((path) => path.startsWith(`${BASE}/templates?`)).length).toBeGreaterThan(before);
  });

  it("offers the subjects in the form, and sends no subject when none is chosen", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny mall" }));
    const select = screen.getByLabelText(/Ämne/);
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Inget ämne", "Naturorienterande ämnen", "Slöjd"]);
    await user.type(screen.getByLabelText("Moment"), "Brandövning");
    await user.click(screen.getByRole("button", { name: "Skapa mallen" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/templates`, { title: "Brandövning" }));
  });

  it("says what is missing, and sends nothing, when the moment has no name or the text is too long", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny mall" }));
    await user.click(screen.getByRole("button", { name: "Skapa mallen" }));
    expect(await screen.findByText("Skriv namnet på momentet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Moment")).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("Moment"));
    await user.paste("x".repeat(121));
    await user.click(screen.getByRole("button", { name: "Skapa mallen" }));
    expect(await screen.findByText("Namnet får vara högst 120 tecken.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says a second moment in the same subject is refused, with the form left as it was", async () => {
    api.post.mockRejectedValueOnce(apiError(409, "CHECKLIST_TEMPLATE_EXISTS"));
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny mall" }));
    await user.type(screen.getByLabelText("Moment"), "Maskinerna");
    await user.click(screen.getByRole("button", { name: "Skapa mallen" }));
    expect(await screen.findByText("Det momentet finns redan i det ämnet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Moment")).toHaveValue("Maskinerna");
    // Typing again takes the sentence away.
    await user.type(screen.getByLabelText("Moment"), "2");
    expect(screen.queryByText("Det momentet finns redan i det ämnet.")).not.toBeInTheDocument();
  });

  it("closes the form on Avbryt without sending", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny mall" }));
    await user.click(within(screen.getByRole("region", { name: "Mallar" })).getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByLabelText("Moment")).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("changes a template in place and sends only what changed", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Redigera Maskinerna" }));
    const title = screen.getByLabelText("Moment");
    expect(title).toHaveValue("Maskinerna");
    expect(screen.getByLabelText(/Ämne/)).toHaveValue("s-slojd");
    await user.clear(title);
    await user.type(title, "Sågarna");
    await user.selectOptions(screen.getByLabelText(/Ämne/), "");
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`${BASE}/templates/t-1`, { title: "Sågarna", subjectId: null }));
    await waitFor(() => expect(screen.queryByLabelText("Moment")).not.toBeInTheDocument());
  });

  it("sends nothing when a change changes nothing, and still closes the form", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Redigera Maskinerna" }));
    await user.click(screen.getByRole("button", { name: "Spara" }));
    await waitFor(() => expect(screen.queryByLabelText("Moment")).not.toBeInTheDocument());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("holds a subject the list of subjects does not have, so that the select keeps its value", async () => {
    state.templates = [template({ id: "t-9", subjectId: "s-gone", subjectName: "Gamla ämnet", title: "Rest" })];
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Redigera Rest" }));
    const select = screen.getByLabelText(/Ämne/);
    await waitFor(() => expect(select).toHaveValue("s-gone"));
    expect(within(select).getByRole("option", { name: "Gamla ämnet" })).toBeInTheDocument();
  });

  it("warns when the subjects cannot be read, and still lets the template be saved without one", async () => {
    supabase.client = { from: () => ({ select: () => ({ order: () => ({ order: () => Promise.resolve({ data: null, error: { message: "denied" } }) }) }) }) };
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Ny mall" }));
    expect(await screen.findByText(/Ämnena kunde inte hämtas/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Moment"), "Brandövning");
    await user.click(screen.getByRole("button", { name: "Skapa mallen" }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
  });

  it("retires a template and brings a retired one back, with a PATCH of the one field", async () => {
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Avveckla Maskinerna" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`${BASE}/templates/t-1`, { active: false }));
    await user.click(await screen.findByRole("button", { name: "Ta fram igen Svarven" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`${BASE}/templates/t-4`, { active: true }));
  });

  it("says why a template could not be retired", async () => {
    api.patch.mockRejectedValueOnce(apiError(404, "CHECKLIST_NOT_FOUND"));
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Avveckla Maskinerna" }));
    expect(await screen.findByText("Det finns inte längre, eller är inte ditt att se. Ladda om sidan.")).toBeInTheDocument();
    expect(screen.getByText("Mallen kunde inte sparas")).toBeInTheDocument();
  });

  it("says a school with no template has none yet, and a list that cannot be read", async () => {
    state.templates = [];
    await open();
    expect(await screen.findByRole("heading", { name: "Inga mallar än" })).toBeInTheDocument();
  });

  it("says the templates could not be fetched, and reads them again on Försök igen", async () => {
    state.fails = { templates: apiError(500) };
    const user = await open();
    const card = await screen.findByRole("region", { name: "Mallar" });
    expect(await within(card).findByText("Mallarna kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(within(card).getByRole("button", { name: "Försök igen" }));
    expect(await within(card).findByText("Maskinerna")).toBeInTheDocument();
  });

  it("is read-only for a läsare: the templates show, with no way to make or change one", async () => {
    profile.readOnly = true;
    await open();
    expect(await screen.findByText("Maskinerna")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ny mall" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Redigera/ })).not.toBeInTheDocument();
  });

  it("is not on the teacher's page, and the teacher reads only the active templates", async () => {
    await open("teacher");
    await screen.findByRole("region", { name: "Bocka av" });
    expect(screen.queryByRole("region", { name: "Mallar" })).not.toBeInTheDocument();
    expect(reads(api)).toContain(`${BASE}/templates`);
    expect(reads(api)).not.toContain(`${BASE}/templates?includeRetired=true`);
    // The retired template is not offered.
    expect(within(screen.getByLabelText("Mall")).queryByRole("option", { name: /Svarven/ })).not.toBeInTheDocument();
  });
});

describe("Bocka av", () => {
  it("reads no pupil until a template and a group are both chosen", async () => {
    const user = await open();
    const template = await screen.findByLabelText("Mall");
    expect(screen.getByText("Välj mall och grupp för att se eleverna.")).toBeInTheDocument();
    await user.selectOptions(template, "t-1");
    expect(reads(api).some((path) => path.includes("/roster"))).toBe(false);
    await user.selectOptions(screen.getByLabelText("Grupp"), "g-7a");
    await screen.findByRole("table", { name: /Eleverna i/ });
    expect(reads(api)).toContain(`${BASE}/templates/t-1/roster?groupId=g-7a`);
  });

  it("offers the active templates as Ämne – Moment, and the groups with what the reader teaches in them", async () => {
    await open();
    const templates = await screen.findByLabelText("Mall");
    expect(within(templates).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Välj mall…",
      "Slöjd – Maskinerna",
      "Naturorienterande ämnen – Laborationssäkerhet",
      "Brandövning",
    ]);
    const groups = screen.getByLabelText("Grupp");
    expect(within(groups).getAllByRole("option").map((option) => option.textContent)).toEqual(["Välj grupp…", "7A · Slöjd", "Slöjd 7 · Slöjd", "8B"]);
  });

  it("groups what a teacher may tick apart from the classes they only look at", async () => {
    await open("teacher");
    const groups = await screen.findByLabelText("Grupp");
    expect(within(groups).getByRole("group", { name: "Dina grupper" })).toBeInTheDocument();
    const lookOnly = within(groups).getByRole("group", { name: "Bara läsning" });
    expect(within(lookOnly).getByRole("option", { name: "8B" })).toBeInTheDocument();
    expect(screen.getByText(/klasser du är mentor för men inte undervisar/)).toBeInTheDocument();
  });

  it("shows each pupil's latest instruction, who gave it, how many came before, and the count", async () => {
    const user = await open();
    const table = await chooseRoster(user);
    expect(await screen.findByText("2 av 4 har fått instruktion")).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    // Ada: the latest of two, by the instructor.
    expect(within(rows[1]!).getByText(`Instruktion ${day("2026-10-03")} av Anna Svensson`)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("+1 tidigare")).toBeInTheDocument();
    // Bo: nothing yet.
    expect(within(rows[2]!).getByText("Saknas")).toBeInTheDocument();
    // Dan: no instructor named, so the one who wrote it.
    expect(within(rows[4]!).getByText(`Instruktion ${day("2026-10-02")} av Cecilia Sand`)).toBeInTheDocument();
    expect(within(rows[4]!).queryByText(/tidigare/)).not.toBeInTheDocument();
  });

  it("says a tick with no name behind it only by its day, and shows a tick's note", async () => {
    state.roster = roster({ rows: [row("p-x", "Xe Nil", { proofs: [proof({ instructorName: null, recordedByName: null, note: "Med skyddsglasögon" })] })] });
    const user = await open();
    await chooseRoster(user);
    expect(await screen.findByText(`Instruktion ${day("2026-10-03")}`)).toBeInTheDocument();
    expect(screen.getByText("Med skyddsglasögon")).toBeInTheDocument();
  });

  it("gives a box only to the pupils the reader may tick, and says the others are read only", async () => {
    const user = await open();
    const table = await chooseRoster(user);
    expect(within(table).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(table).queryByRole("checkbox", { name: "Välj Cia Lund" })).not.toBeInTheDocument();
    expect(within(table).getByText("Bara läsning")).toBeInTheDocument();
  });

  it("chooses everyone who is missing and clears the choice", async () => {
    const user = await open();
    const table = await chooseRoster(user);
    await user.click(screen.getByRole("button", { name: "Välj alla som saknas" }));
    expect(within(table).getByRole("checkbox", { name: "Välj Bo Ek" })).toBeChecked();
    expect(within(table).getByRole("checkbox", { name: "Välj Ada Berg" })).not.toBeChecked();
    expect(screen.getByText("1 elev vald")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rensa val" }));
    expect(within(table).getByRole("checkbox", { name: "Välj Bo Ek" })).not.toBeChecked();
    expect(screen.getByText("Ingen elev vald")).toBeInTheDocument();
  });

  it("ticks the chosen with the date defaulting to today, left to the gateway's clock, and says what came of it", async () => {
    api.post.mockResolvedValueOnce({ written: 2, already: 1 });
    const user = await open();
    const table = await chooseRoster(user);
    expect(screen.getByLabelText("Datum för instruktionen")).toHaveValue(TODAY);
    expect(screen.getByLabelText("Den som gav instruktionen")).toHaveValue("");
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    await user.click(within(table).getByRole("checkbox", { name: "Välj Ada Berg" }));
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/proofs`, { templateId: "t-1", studentIds: ["p-bo", "p-ada"] }));
    expect(await screen.findAllByText("2 elever bockades av. 1 elev hade redan en bock för dagen.")).not.toHaveLength(0);
    // The choice is cleared, and the roster was read again.
    expect(within(table).getByRole("checkbox", { name: "Välj Bo Ek" })).not.toBeChecked();
    await waitFor(() => expect(reads(api).filter((path) => path.includes("/roster")).length).toBeGreaterThan(1));
  });

  it("ticks a day gone by, by another instructor, with a note", async () => {
    const user = await open();
    const table = await chooseRoster(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    const date = screen.getByLabelText("Datum för instruktionen");
    await user.clear(date);
    await user.type(date, "2026-09-30");
    await waitFor(() => expect(within(screen.getByLabelText("Den som gav instruktionen")).getAllByRole("option")).toHaveLength(3));
    await user.selectOptions(screen.getByLabelText("Den som gav instruktionen"), "u-bo");
    await user.type(screen.getByLabelText(/Anteckning/), " Med handledare ");
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`${BASE}/proofs`, {
        templateId: "t-1",
        studentIds: ["p-bo"],
        instructedOn: "2026-09-30",
        instructorId: "u-bo",
        note: "Med handledare",
      }),
    );
  });

  it("refuses a day that has not come, and sends nothing", async () => {
    const user = await open();
    const table = await chooseRoster(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    const date = screen.getByLabelText("Datum för instruktionen");
    await user.clear(date);
    await user.type(date, TOMORROW);
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText("Dagen har inte kommit.")).toBeInTheDocument();
    expect(date).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("refuses a form with no pupil chosen, and a note that is too long, and sends nothing", async () => {
    const user = await open();
    await chooseRoster(user);
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText("Välj minst en elev.")).toBeInTheDocument();
    const note = screen.getByLabelText(/Anteckning/);
    await user.click(screen.getByRole("button", { name: "Välj alla som saknas" }));
    await user.click(note);
    await user.paste("n".repeat(501));
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText("Anteckningen får vara högst 500 tecken.")).toBeInTheDocument();
    expect(note).toHaveFocus();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says a refusal in a sentence, with what was chosen still there", async () => {
    api.post.mockRejectedValueOnce(apiError(409, "CHECKLIST_TEMPLATE_RETIRED"));
    const user = await open();
    const table = await chooseRoster(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText(/Mallen är avvecklad, så det går inte att bocka av i den/)).toBeInTheDocument();
    expect(screen.getByText("Det gick inte att bocka av")).toBeInTheDocument();
    expect(within(table).getByRole("checkbox", { name: "Välj Bo Ek" })).toBeChecked();
  });

  it("says a teacher may only tick their own pupils, and that the gateway's throttle is a wait", async () => {
    api.post.mockRejectedValueOnce(apiError(403, "CHECKLIST_NOT_YOUR_PUPIL")).mockRejectedValueOnce(apiError(429, undefined, "ThrottlerException: Too Many Requests"));
    const user = await open("teacher");
    const table = await chooseRoster(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText(/Du kan bara bocka av elever i dina egna grupper och lektioner/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText("Du gör det för ofta. Vänta en minut och försök igen.")).toBeInTheDocument();
  });

  it("falls back to the gateway's own words for a failure we have no sentence for", async () => {
    api.post.mockRejectedValueOnce(apiError(500, undefined, "Något hos servern"));
    const user = await open();
    const table = await chooseRoster(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText("Något hos servern")).toBeInTheDocument();
  });

  it("keeps the roster as it was last read when a read again fails, and says so", async () => {
    api.post.mockResolvedValueOnce({ written: 1, already: 0 });
    const user = await open();
    const table = await chooseRoster(user);
    await user.click(within(table).getByRole("checkbox", { name: "Välj Bo Ek" }));
    state.fails = { roster: apiError(500) };
    await user.click(screen.getByRole("button", { name: "Bocka av valda" }));
    expect(await screen.findByText("Eleverna kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText(/Det som visas är det som senast hämtades/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Eleverna i/ })).toBeInTheDocument();
  });

  it("gives a group the reader may only look at no box and no form, and still counts it", async () => {
    // The gateway says canVoid per tick: a group the reader only looks at holds none they may void.
    state.roster = roster({
      rows: ROWS.map((one) => ({ ...one, canTick: false, proofs: one.proofs.map((tick) => ({ ...tick, canVoid: false })) })),
      group: { id: "g-8b", name: "8B", kind: "CLASS" },
    });
    const user = await open("teacher");
    const table = await chooseRoster(user, "t-1", "g-8b");
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bocka av valda" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Välj alla som saknas" })).not.toBeInTheDocument();
    expect(screen.getByText("2 av 4 har fått instruktion")).toBeInTheDocument();
    // Nothing to void in a group the reader cannot tick.
    expect(screen.queryByRole("button", { name: /Upphäv bocken/ })).not.toBeInTheDocument();
  });

  it("offers Upphäv only on a tick the gateway says the reader may void: a teacher's colleague's tick has none", async () => {
    state.roster = roster({
      rows: [
        row("p-ada", "Ada Berg", { proofs: [proof({ canVoid: true })] }),
        row("p-bo", "Bo Ek", { proofs: [proof({ id: "pr-x", canVoid: false, recordedByName: "Cecilia Sand", instructorName: "Cecilia Sand" })] }),
      ],
    });
    const user = await open("teacher");
    const table = await chooseRoster(user);
    expect(within(table).getByRole("button", { name: `Upphäv bocken för Ada Berg, ${day("2026-10-03")}` })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /Upphäv bocken för Bo Ek/ })).not.toBeInTheDocument();
    // The tick itself is still there to read.
    expect(within(table).getByText(`Instruktion ${day("2026-10-03")} av Cecilia Sand`)).toBeInTheDocument();
  });

  it("is read-only for a läsare: the roster shows and nothing can be ticked or voided", async () => {
    profile.readOnly = true;
    const user = await open();
    const table = await chooseRoster(user);
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bocka av valda" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upphäv bocken/ })).not.toBeInTheDocument();
    expect(reads(api)).not.toContain(`${BASE}/instructors`);
  });

  it("says a group with no pupil the reader may see has none, and keeps Skriv ut from printing nothing", async () => {
    state.roster = roster({ rows: [] });
    const user = await open();
    await chooseRoster(user).catch(() => undefined);
    expect(await screen.findByRole("heading", { name: "Inga elever att visa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skriv ut" })).toBeDisabled();
  });

  it("says the pupils could not be fetched and reads them again; a template or group that is gone is another sentence", async () => {
    state.fails = { roster: apiError(500) };
    const user = await open();
    await user.selectOptions(await screen.findByLabelText("Mall"), "t-1");
    await user.selectOptions(screen.getByLabelText("Grupp"), "g-7a");
    expect(await screen.findByText("Eleverna kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("table", { name: /Eleverna i/ })).toBeInTheDocument();
  });

  it("says a template or a group that has gone is gone", async () => {
    state.fails = { roster: apiError(404, "CHECKLIST_NOT_FOUND") };
    const user = await open();
    await user.selectOptions(await screen.findByLabelText("Mall"), "t-1");
    await user.selectOptions(screen.getByLabelText("Grupp"), "g-7a");
    expect(await screen.findByText("Mallen eller gruppen finns inte")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Försök igen" })).not.toBeInTheDocument();
  });

  it("warns, and ticks in the reader's own name, when the staff list cannot be read", async () => {
    state.fails = { instructors: apiError(500) };
    const user = await open();
    await chooseRoster(user);
    expect(await screen.findByText(/Personallistan kunde inte hämtas/)).toBeInTheDocument();
  });

  it("says there is nothing to tick in when the school has no active template, and what to do about it", async () => {
    state.templates = [template({ active: false })];
    await open("teacher");
    expect(await screen.findByRole("heading", { name: "Det finns inga mallar att bocka av i" })).toBeInTheDocument();
    expect(screen.getByText(/En administratör gör mallarna/)).toBeInTheDocument();
  });

  it("says there is nothing to tick in when the reader has no group", async () => {
    state.groups = [];
    await open("teacher");
    expect(await screen.findByRole("heading", { name: "Det finns inga grupper att visa" })).toBeInTheDocument();
    expect(screen.getByText(/Du undervisar ingen grupp/)).toBeInTheDocument();
  });

  it("says the templates and groups could not be fetched, and tries again", async () => {
    state.fails = { groups: apiError(500) };
    const user = await open("teacher");
    expect(await screen.findByText("Mallarna och grupperna kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByLabelText("Mall")).toBeInTheDocument();
  });

  it("forgets a template that was retired while it was chosen: the roster goes and the choice is asked for again", async () => {
    const user = await open();
    await chooseRoster(user);
    // The administrator retires the template that is open on the roster.
    state.templates = TEMPLATES.map((one) => (one.id === "t-1" ? { ...one, active: false } : one));
    await user.click(await screen.findByRole("button", { name: "Avveckla Maskinerna" }));
    expect(await screen.findByText("Välj mall och grupp för att se eleverna.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Eleverna i/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mall")).toHaveValue("");
  });
});

describe("voiding a tick", () => {
  const openVoid = async (user: ReturnType<typeof userEvent.setup>) => {
    await chooseRoster(user);
    await user.click(screen.getByRole("button", { name: `Upphäv bocken för Ada Berg, ${day("2026-10-03")}` }));
    return screen.findByRole("dialog", { name: "Upphäv bocken" });
  };

  it("asks for a reason, says the tick stays on the pupil's card, and sends the trimmed reason", async () => {
    const user = await open();
    const dialog = await openVoid(user);
    expect(within(dialog).getByText(/finns kvar på elevens kort, markerad som upphävd/)).toBeInTheDocument();
    expect(within(dialog).getByText(`Ada Berg · Maskinerna, ${day("2026-10-03")}`)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Varför upphävs bocken?"), "  Fel elev ");
    await user.click(within(dialog).getByRole("button", { name: "Upphäv bocken" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/proofs/pr-1/void`, { reason: "Fel elev" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The roster was read again.
    await waitFor(() => expect(reads(api).filter((path) => path.includes("/roster")).length).toBeGreaterThan(1));
  });

  it("will not void without a reason, or with one that is too long", async () => {
    const user = await open();
    const dialog = await openVoid(user);
    await user.click(within(dialog).getByRole("button", { name: "Upphäv bocken" }));
    expect(await within(dialog).findByText("Skriv varför bocken upphävs.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Varför upphävs bocken?")).toHaveFocus();
    await user.paste("r".repeat(301));
    await user.click(within(dialog).getByRole("button", { name: "Upphäv bocken" }));
    expect(await within(dialog).findByText("Orsaken får vara högst 300 tecken.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("closes on Avbryt without voiding", async () => {
    const user = await open();
    const dialog = await openVoid(user);
    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("tells a teacher who is not the writer that only the writer or an administrator can void it", async () => {
    api.post.mockRejectedValueOnce(apiError(404, "CHECKLIST_NOT_FOUND"));
    const user = await open("teacher");
    const dialog = await openVoid(user);
    await user.type(within(dialog).getByLabelText("Varför upphävs bocken?"), "Fel dag");
    await user.click(within(dialog).getByRole("button", { name: "Upphäv bocken" }));
    expect(await within(dialog).findByText(/Du kan bara upphäva bockar du själv har gjort/)).toBeInTheDocument();
    expect(within(dialog).getByText("Bocken kunde inte upphävas")).toBeInTheDocument();
  });

  it("says any other refusal in its own sentence", async () => {
    api.post.mockRejectedValueOnce(apiError(422, "CHECKLIST_REASON_NEEDED"));
    const user = await open();
    const dialog = await openVoid(user);
    await user.type(within(dialog).getByLabelText("Varför upphävs bocken?"), "Fel dag");
    await user.click(within(dialog).getByRole("button", { name: "Upphäv bocken" }));
    expect(await within(dialog).findByText("Skriv en kort orsak till varför bocken upphävs.")).toBeInTheDocument();
  });

  it("says the dialog could not be opened when its chunk does not arrive, and fetches again on the next click", async () => {
    const user = await open();
    await chooseRoster(user);
    // A name opens the card; if the lazily fetched module fails, the page says so and stays usable.
    await user.click(screen.getByRole("button", { name: "Öppna elevkort för Ada Berg" }));
    expect(await screen.findByRole("dialog", { name: "Ada Berg" })).toBeInTheDocument();
  });
});

describe("a pupil's card", () => {
  const openCard = async (user: ReturnType<typeof userEvent.setup>) => {
    await chooseRoster(user);
    await user.click(screen.getByRole("button", { name: "Öppna elevkort för Ada Berg" }));
    return screen.findByRole("dialog", { name: "Ada Berg" });
  };

  it("shows every tick, the voided one with who, when and why, and where the pupil stands on each list", async () => {
    const user = await open();
    const dialog = await openCard(user);
    expect(reads(api)).toContain(`${BASE}/students/p-ada`);
    const proofs = within(await within(dialog).findByRole("region", { name: "Instruktionsbevis" })).getAllByRole("listitem");
    expect(proofs).toHaveLength(2);
    expect(within(proofs[0]!).getByText("Slöjd – Maskinerna")).toBeInTheDocument();
    expect(within(proofs[0]!).getByText(`Instruktion ${day("2026-10-03")} av Anna Svensson`)).toBeInTheDocument();
    // The voided tick stays, and says so in words.
    expect(within(proofs[1]!).getByText("Upphävd")).toBeInTheDocument();
    expect(within(proofs[1]!).getByText(/av Bo Ek: Fel elev/)).toBeInTheDocument();
    expect(within(proofs[1]!).getByText(/Anteckning: Bara svarven/)).toBeInTheDocument();
    expect(within(proofs[1]!).queryByRole("button", { name: /Upphäv/ })).not.toBeInTheDocument();
    const consents = within(within(dialog).getByRole("region", { name: "Samtycken" })).getAllByRole("listitem");
    expect(consents).toHaveLength(3);
    expect(within(consents[0]!).getByText("Samtycke")).toBeInTheDocument();
    expect(within(consents[1]!).getByText("Avslutad")).toBeInTheDocument();
    expect(within(consents[1]!).getByText("Frågad i appen")).toBeInTheDocument();
    expect(within(consents[1]!).getByText(/Tidigare: Återkallat/)).toBeInTheDocument();
    expect(within(consents[2]!).getByText("Saknas")).toBeInTheDocument();
  });

  it("voids a valid tick in place of the lists, and comes back to the card", async () => {
    const user = await open();
    const dialog = await openCard(user);
    await user.click(await within(dialog).findByRole("button", { name: `Upphäv bocken för Ada Berg, ${day("2026-10-03")}` }));
    await user.type(within(dialog).getByLabelText("Varför upphävs bocken?"), "Fel elev");
    await user.click(within(dialog).getByRole("button", { name: "Upphäv bocken" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${BASE}/proofs/pr-1/void`, { reason: "Fel elev" }));
    expect(await within(dialog).findByRole("region", { name: "Instruktionsbevis" })).toBeInTheDocument();
  });

  it("goes back to the card from the void step on Avbryt", async () => {
    const user = await open();
    const dialog = await openCard(user);
    await user.click(await within(dialog).findByRole("button", { name: /Upphäv bocken för/ }));
    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    expect(await within(dialog).findByRole("region", { name: "Instruktionsbevis" })).toBeInTheDocument();
  });

  it("says a pupil with nothing has nothing", async () => {
    state.card = card({ proofs: [], consents: [] });
    const user = await open();
    const dialog = await openCard(user);
    expect(await within(dialog).findByText("Eleven har inga bockar än.")).toBeInTheDocument();
    expect(within(dialog).getByText("Eleven finns inte på någon samtyckeslista.")).toBeInTheDocument();
  });

  it("names nobody for a voided tick whose voider is gone, and shows a valid tick with no instructor by its day", async () => {
    state.card = card({
      proofs: [
        {
          ...proof({ instructorName: null, recordedByName: null }),
          templateId: "t-1",
          templateTitle: "Maskinerna",
          subjectName: null,
          voidedAt: "2026-10-04T08:00:00.000Z",
          voidedByName: null,
          voidReason: "Dubblett",
        },
        { ...proof({ id: "pr-3", instructorName: null, recordedByName: null }), templateId: "t-3", templateTitle: "Brandövning", subjectName: null, voidedAt: null, voidedByName: null, voidReason: null },
      ],
    });
    const user = await open();
    const dialog = await openCard(user);
    expect(await within(dialog).findByText(/av okänd: Dubblett/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(`Instruktion ${day("2026-10-03")}`)).toHaveLength(2);
  });

  it("offers Upphäv on the card only on a tick the reader may void", async () => {
    state.card = card({
      proofs: [
        { ...proof({ canVoid: false }), templateId: "t-1", templateTitle: "Maskinerna", subjectName: null, voidedAt: null, voidedByName: null, voidReason: null },
        { ...proof({ id: "pr-y", canVoid: true, instructedOn: "2026-09-01" }), templateId: "t-2", templateTitle: "Brandövning", subjectName: null, voidedAt: null, voidedByName: null, voidReason: null },
      ],
    });
    const user = await open();
    const dialog = await openCard(user);
    await within(dialog).findByRole("region", { name: "Instruktionsbevis" });
    expect(within(dialog).getAllByRole("button", { name: /Upphäv bocken/ })).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: `Upphäv bocken för Ada Berg, ${day("2026-09-01")}` })).toBeInTheDocument();
  });

  it("is read-only for a läsare: no tick to void on the card", async () => {
    profile.readOnly = true;
    const user = await open();
    const dialog = await openCard(user);
    await within(dialog).findByRole("region", { name: "Instruktionsbevis" });
    expect(within(dialog).queryByRole("button", { name: /Upphäv bocken/ })).not.toBeInTheDocument();
  });

  it("says a pupil who is not the reader's to see is not, and offers no retry", async () => {
    state.fails = { card: apiError(404, "CHECKLIST_NOT_FOUND") };
    const user = await open();
    const dialog = await openCard(user);
    expect(await within(dialog).findByText("Eleven finns inte, eller är inte din att se")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Försök igen" })).not.toBeInTheDocument();
  });

  it("says the card could not be fetched and reads it again", async () => {
    state.fails = { card: apiError(500) };
    const user = await open();
    const dialog = await openCard(user);
    expect(await within(dialog).findByText("Elevkortet kunde inte hämtas")).toBeInTheDocument();
    state.fails = {};
    await user.click(within(dialog).getByRole("button", { name: "Försök igen" }));
    expect(await within(dialog).findByRole("region", { name: "Instruktionsbevis" })).toBeInTheDocument();
  });
});

describe("in English", () => {
  it("has the same screens in the other language", async () => {
    const user = userEvent.setup();
    renderChecklists(<Checklists audience="admin" />, "en");
    expect(await screen.findByRole("tab", { name: "Instruction proofs" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Templates" })).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText("Template"), "t-1");
    await user.selectOptions(screen.getByLabelText("Group"), "g-7a");
    expect(await screen.findByText("2 of 4 have had the instruction")).toBeInTheDocument();
    // Bo, and Cia who is read only: neither has a tick.
    expect(screen.getAllByText("Missing")).toHaveLength(2);
  });
});
