import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { detail, listItem } from "@/lib/__fixtures__/checklists";
import { BASE, apiError, installApi, reads, renderChecklists, scenario, warmChecklists, type Scenario } from "@/lib/__fixtures__/checklists-render";
import { Checklists } from "./checklists";

/**
 * Skriv ut, for a roster and for a consent list: a pupil the school has marked
 * as having a protected identity is named on the screen (the reader reads the
 * register already) and not on the paper, which says how many are left out.
 *
 * The paper is the gateway's: at the click the web asks for the roster or the list
 * "for paper" (GET .../roster/print, GET .../consent-lists/:id/print), where the
 * marked pupils are already out of the rows and the counts and `heldOut` counts
 * them (the stub gateway in lib/__fixtures__/checklists-render.tsx does as the
 * gateway does), so a teacher, who cannot read the marks, prints too.
 *
 * What this guards: the paper is asked for at the click and not before, and is not
 * kept for the next click; the sheet is drawn from that answer alone, with the
 * count, before the browser's print opens; the web never reads the marks itself; a
 * read that fails prints nothing and says so; the page is the sheet alone while it
 * prints and is itself again after; and the sheet holds what a roster and a list
 * are to hold on paper.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => false }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const day = (iso: string) => new Intl.DateTimeFormat("sv", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

let state: Scenario;
/** What the paper held at the moment the browser's print was called. */
let paper: { text: string; page: string; screen: string } | null;
let print: ReturnType<typeof vi.spyOn>;

beforeAll(() => warmChecklists(), 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  state = scenario();
  installApi(api, state);
  paper = null;
  print = vi.spyOn(window, "print").mockImplementation(() => {
    paper = {
      text: document.querySelector(".print-sheet-root")?.textContent ?? "",
      page: document.documentElement.className,
      screen: document.body.textContent ?? "",
    };
  });
});

afterEach(() => {
  print.mockRestore();
  document.documentElement.classList.remove("printing-sheet");
});

const paperReads = () => reads(api).filter((path) => path.includes("/print"));
const marksReads = () => reads(api).filter((path) => path.includes("person-protections"));
const sheet = () => document.querySelector(".print-sheet-root");

async function openRoster() {
  const user = userEvent.setup({ delay: null });
  renderChecklists(<Checklists audience="admin" />);
  await user.selectOptions(await screen.findByLabelText("Mall"), "t-1");
  await user.selectOptions(screen.getByLabelText("Grupp"), "g-7a");
  await screen.findByRole("table", { name: /Eleverna i/ });
  return user;
}

async function openConsentList(locale: "sv" | "en" = "sv") {
  const user = userEvent.setup({ delay: null });
  renderChecklists(<Checklists audience="admin" />, locale);
  await user.click(screen.getByRole("tab", { name: locale === "sv" ? "Samtycken" : "Consents" }));
  await user.click(await screen.findByRole("button", { name: /^(Öppna|Open) Fotografering HT 2026/ }));
  await screen.findByRole("table", { name: /(Eleverna och deras svar|The pupils and their answers)/ });
  return user;
}

const afterPrint = () => act(() => void window.dispatchEvent(new Event("afterprint")));

describe("printing a roster", () => {
  it("asks the gateway for the paper at the click and not before, and prints only what it answers: the marked pupils are out and counted", async () => {
    state.marks = ["p-bo"];
    const user = await openRoster();
    expect(paperReads()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paperReads()).toEqual([`${BASE}/templates/t-1/roster/print?groupId=g-7a`]);
    // The web never reads the marks itself.
    expect(marksReads()).toEqual([]);
    // The paper: the template, the group, the count of everyone, the pupils who are not marked, and how many are left out.
    expect(paper!.text).toContain("Slöjd – Maskinerna");
    expect(paper!.text).toContain("Grupp: 7A");
    // The counts are of the pupils on the paper: Bo is out, and Ada and Dan are the two who have had it.
    expect(paper!.text).toContain("2 av 3 har fått instruktion");
    expect(paper!.text).toContain("Ada Berg");
    expect(paper!.text).toContain(`Instruktion ${day("2026-10-03")} av Anna Svensson`);
    expect(paper!.text).toContain("+1 tidigare");
    expect(paper!.text).toContain("Dan Dal");
    expect(paper!.text).toContain("Cia Lund");
    expect(paper!.text).not.toContain("Bo Ek");
    // Cia has no tick, and says so: one Saknas, not two.
    expect(paper!.text.match(/Saknas/g)).toHaveLength(1);
    expect(paper!.text).toContain("1 elev med skyddad identitet är inte med i utskriften. Se skärmen.");
    // The page is the sheet alone while it prints.
    expect(paper!.page).toContain("printing-sheet");
    // The screen names everyone the reader may see, the marked pupil too.
    expect(within(screen.getByRole("table", { name: /Eleverna i/ })).getByRole("button", { name: "Öppna elevkort för Bo Ek" })).toBeInTheDocument();
  });

  it("puts the page back when the browser says the print is done, and asks for the paper afresh the next time", async () => {
    state.marks = ["p-bo"];
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(sheet()).not.toBeNull();
    afterPrint();
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.documentElement.classList.contains("printing-sheet")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(2));
    // Not kept: a mark set in between holds the pupil out of the next paper.
    expect(paperReads()).toHaveLength(2);
  });

  it("puts the page back at the reader's next click for a browser that never says the print is done", async () => {
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(sheet()).not.toBeNull();
    await user.click(document.body);
    await waitFor(() => expect(sheet()).toBeNull());
    expect(document.documentElement.classList.contains("printing-sheet")).toBe(false);
  });

  it("says nothing about protected identities when no pupil on the paper is marked, also when others in the school are", async () => {
    state.marks = ["p-someone-in-another-class"];
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).toContain("Bo Ek");
    expect(paper!.text).toContain("Saknas");
    expect(paper!.text).not.toContain("skyddad identitet");
  });

  it("counts every marked pupil it leaves out", async () => {
    state.marks = ["p-bo", "p-dan", "p-ada"];
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).toContain("3 elever med skyddad identitet är inte med i utskriften. Se skärmen.");
    expect(paper!.text).toContain("Cia Lund");
    for (const name of ["Ada Berg", "Bo Ek", "Dan Dal"]) expect(paper!.text).not.toContain(name);
  });

  it("prints nothing, and says so, when the paper cannot be had", async () => {
    state.fails = { paper: apiError(500) };
    state.marks = ["p-bo"];
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Utskriften gjordes inte")));
    expect(print).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
    expect(document.documentElement.classList.contains("printing-sheet")).toBe(false);
    // The button is usable again, and the next click tries again.
    state.fails = {};
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).not.toContain("Bo Ek");
  });

  it("prints nothing when the gateway refuses the paper (403)", async () => {
    state.fails = { paper: apiError(403, undefined, "Forbidden resource") };
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(print).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("lets a teacher print too, with the marked pupils out: the marks are the gateway's to hold out, not the teacher's to read", async () => {
    state.marks = ["p-bo"];
    const user = userEvent.setup({ delay: null });
    renderChecklists(<Checklists audience="teacher" />);
    await user.selectOptions(await screen.findByLabelText("Mall"), "t-1");
    await user.selectOptions(screen.getByLabelText("Grupp"), "g-7a");
    await screen.findByRole("table", { name: /Eleverna i/ });
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).not.toContain("Bo Ek");
    expect(paper!.text).toContain("1 elev med skyddad identitet är inte med i utskriften. Se skärmen.");
    expect(marksReads()).toEqual([]);
  });

  it("says Förbereder… while the paper is asked for, and ignores a second click", async () => {
    let release: (() => void) | undefined;
    const slow = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (path: string) => {
      if (path.includes("/print")) await new Promise<void>((resolve) => (release = resolve));
      return slow(path);
    });
    const user = await openRoster();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    const busy = await screen.findByRole("button", { name: "Förbereder…" });
    expect(busy).toBeDisabled();
    release!();
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paperReads()).toHaveLength(1);
  });

  it("prints a roster in English too", async () => {
    state.marks = ["p-bo"];
    const user = userEvent.setup({ delay: null });
    renderChecklists(<Checklists audience="admin" />, "en");
    await user.selectOptions(await screen.findByLabelText("Template"), "t-1");
    await user.selectOptions(screen.getByLabelText("Group"), "g-7a");
    await screen.findByRole("table", { name: /The pupils in/ });
    await user.click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).toContain("1 pupil with a protected identity is not on the printout. See the screen.");
    expect(paper!.text).toContain("Group: 7A");
    expect(paper!.text).toContain("Ada Berg");
  });
});

describe("printing a consent list", () => {
  it("holds the marked pupils out and says what the paper holds: the title, the class, the text, the counts, and for each pupil the state, the day and who", async () => {
    state.marks = ["p-fia", "p-cia"];
    const user = await openConsentList();
    expect(paperReads()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paperReads()).toEqual([`${BASE}/consent-lists/l-1/print`]);
    expect(marksReads()).toEqual([]);
    const text = paper!.text;
    expect(text).toContain("Fotografering HT 2026");
    expect(text).toContain("Klass: 7A");
    expect(text).toContain("Utskrivet");
    expect(text).toContain("Skolan får fotografera eleven vid skolfotograferingen.");
    // The counts are of the pupils on the paper: Cia (asked) and Fia (missing) are out.
    expect(text).toContain("Samtycke 2 · Har tackat nej 1 · Återkallat 1 · Frågad i appen 0 · Saknas 1");
    expect(text).toContain("Ada Berg");
    expect(text).toContain(`Samtycke ${day("2026-10-03")}`);
    expect(text).toContain("Adas mamma");
    expect(text).toContain(`Återkallat ${day("2026-10-04")}`);
    expect(text).toContain(`Bekräftat i appen ${day("2026-10-06")}`);
    expect(text).toContain("Har tackat nej");
    expect(text).toContain("Gun Ö");
    expect(text).not.toContain("Cia Lund");
    expect(text).not.toContain("Fia Ström");
    expect(text).toContain("2 elever med skyddad identitet är inte med i utskriften. Se skärmen.");
    // A pupil being asked would otherwise show the answer before the question: the paper says who is waited for.
    expect(text).not.toContain("Väntar på");
    // The screen names them.
    expect(screen.getByRole("button", { name: "Öppna elevkort för Cia Lund" })).toBeInTheDocument();
    expect(paper!.page).toContain("printing-sheet");
  });

  it("says who the paper is waiting for when a pupil is being asked", async () => {
    const user = await openConsentList();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).toContain("Väntar på 1 av 2 vårdnadshavare");
    expect(paper!.text).not.toContain("skyddad identitet");
  });

  it("says an ended list is ended", async () => {
    state.detail = detail({ list: { ...detail().list, closedAt: "2026-10-20T10:00:00.000Z" } });
    const user = await openConsentList();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).toMatch(/avslutad .*2026/);
    expect(listItem().closedAt).toBeNull();
  });

  it("prints nothing, and says so, when the marks cannot be read", async () => {
    state.fails = { paper: apiError(500) };
    const user = await openConsentList();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Utskriften gjordes inte")));
    expect(print).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("prints a list in English too", async () => {
    state.marks = ["p-cia"];
    const user = await openConsentList("en");
    await user.click(screen.getByRole("button", { name: "Print" }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(paper!.text).toContain("Class: 7A");
    expect(paper!.text).toContain("Consent 2 · Has declined 1 · Withdrawn 1 · Asked in the app 0 · Missing 2");
    expect(paper!.text).toContain("1 pupil with a protected identity is not on the printout. See the screen.");
  });
});
