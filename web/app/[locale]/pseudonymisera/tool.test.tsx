import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeXlsx } from "@/lib/__fixtures__/xlsx-builder";
import { flattenLabels, type Labels } from "@/lib/pseudonym-labels";
import enMessages from "@/messages/en.json";
import svMessages from "@/messages/sv.json";
import { PseudonymiserareTool } from "./tool";

/*
 * The pseudonymiser's tool, run the way a school's administrator runs it: a file chosen, a column decided, personal data taken out, a
 * safe file and a report handed back. Every test runs with the ways out of a page REPLACED BY TRAPS (the second describe says which): the page
 * promises that nothing leaves the browser, and the surest way to say that is to run all of it and have each trap say it was never touched.
 */

const sv = flattenLabels(svMessages.pseudonymiserare) as Labels;

/** The first non-empty Blob handed to URL.createObjectURL, as text: what a download would have held. */
let downloads: Blob[] = [];

beforeEach(() => {
  downloads = [];
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => (downloads.push(blob), `blob:test/${downloads.length}`), revokeObjectURL: () => undefined }));
  // jsdom does not navigate on an anchor's click and says so; the test only wants to know a download was started.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const csv = (name: string, text: string) => new File([text], name, { type: "text/csv" });

const FILE = [
  "Lärare;Ämne;Klass;Notis",
  "Anna Svensson;Svenska;7A;Anna är sjuk, ring 070-123 45 67",
  "Bo Ek;Matte;7B;Se anna.svensson@skola.se",
  "Anna Svensson;Svenska;7B;Byt sal i morgon",
  "Cia Lind;Engelska;8A;Prov på fredag",
].join("\r\n") + "\r\n";

function setup(labels: Labels = sv, locale = "sv") {
  const user = userEvent.setup();
  render(<PseudonymiserareTool labels={labels} locale={locale} />);
  return user;
}

async function addFile(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText(sv["tool.chooseFiles"]), file);
}

/** The whole way through for FILE: add it, keep the Notis column, run. */
async function runFile(user: ReturnType<typeof userEvent.setup>) {
  await addFile(user, csv("lektioner.csv", FILE));
  const choice = await screen.findByLabelText(sv["col.choiceLabel"].replace("{n}", "4"));
  await user.selectOptions(choice, "keep");
  await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
  return screen.findByRole("region", { name: sv["result.heading"] });
}

describe("the tool, a file at a time", () => {
  it("starts with nothing on it but where to add a file or a paste", () => {
    setup();
    expect(screen.getByLabelText(sv["tool.chooseFiles"])).toBeInTheDocument();
    expect(screen.getByLabelText(sv["tool.pasteLabel"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: sv["tool.run"] })).not.toBeInTheDocument();
  });

  it("reads a file, shows its columns with a proposal where there is one, and asks about the one nobody can place", async () => {
    const user = setup();
    await addFile(user, csv("lektioner.csv", FILE));
    const columns = await screen.findByRole("table", { name: sv["col.caption"].replace("{n}", "1") });
    // The header Lärare says names; Ämne and Klass say structure; Notis is left to the user.
    expect(within(columns).getByText(sv["proposal.none"])).toBeInTheDocument();
    expect(within(columns).getAllByText(/Rubriken säger/)).toHaveLength(3);
    // The examples are on this screen and nowhere else.
    expect(within(columns).getByText(/Anna Svensson/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 kolumn i den här filen saknar förslag");
  });

  it("will not run until every column has a choice, and says how many are waiting", async () => {
    const user = setup();
    await addFile(user, csv("lektioner.csv", FILE));
    const run = await screen.findByRole("button", { name: sv["tool.run"] });
    expect(run).toBeDisabled();
    expect(screen.getByText(/1 kolumn väntar på ditt val/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(sv["col.choiceLabel"].replace("{n}", "4")), "keep");
    expect(run).toBeEnabled();
  });

  it("takes the personal data out, shows what it did without a single original value, and checks its own work", async () => {
    const user = setup();
    const result = await runFile(user);
    expect(within(result).getByRole("table", { name: sv["result.countsHeading"] })).toBeInTheDocument();
    expect(within(result).getByText(sv["result.checkPassed"])).toBeInTheDocument();
    const preview = within(result).getAllByRole("table").at(-1)!;
    expect(preview).toHaveTextContent("NAMN-0001");
    expect(preview).toHaveTextContent("TEL-0001");
    expect(preview).toHaveTextContent("epost-0001@exempel.invalid");
    // Nothing of the original in what is to be sent.
    for (const original of ["Svensson", "Anna", "070-123", "skola.se", "Lind"]) expect(result.textContent, original).not.toContain(original);
  });

  it("takes a column of TF numbers out as TF numbers: proposed from its contents, counted under its own name, never as a personnummer", async () => {
    // A column headed Id says nothing; the TF numbers in it do (X3's door, 2026-11-22). Two numbers, one of them twice.
    const user = setup();
    await addFile(user, csv("kurser.csv", "Id;Namn;Notis\r\n19000101TF01;Anna Svensson;ok\r\n19000101TF02;Bo Ek;ok\r\n19000101tf01;Anna Svensson;ok\r\n"));
    const columns = await screen.findByRole("table", { name: sv["col.caption"].replace("{n}", "1") });
    expect(within(columns).getByText("Innehållet är personnummer eller TF-nummer")).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText(sv["col.choiceLabel"].replace("{n}", "3")), "keep");
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    const result = await screen.findByRole("region", { name: sv["result.heading"] });
    const counts = within(result).getByRole("table", { name: sv["result.countsHeading"] });
    const tfRow = within(counts).getByRole("row", { name: /TF-nummer/ });
    expect(tfRow).toHaveTextContent(/TF-nummer\s*3\s*2/);
    expect(within(counts).queryByRole("row", { name: /^personnummer/ })).toBeNull();
    const preview = within(result).getAllByRole("table").at(-1)!;
    expect(preview).toHaveTextContent("TF-0001");
    expect(preview).toHaveTextContent("TF-0002");
    expect(result.textContent).not.toMatch(/19000101|TF0[12]\b/i);
    // A TF number has no check digit, so there is no line about one.
    expect(within(result).queryByText(/kontrollsiffran stämde/)).toBeNull();
  });

  it("hands out a file only after the person has looked through the preview, and what it hands out is the safe text", async () => {
    const user = setup();
    const result = await runFile(user);
    const download = within(result).getByRole("button", { name: sv["result.downloadFile"].replace("{n}", "1") });
    expect(download).toBeDisabled();
    expect(within(result).getByRole("button", { name: sv["result.downloadReport"] })).toBeDisabled();

    await user.click(within(result).getByLabelText(sv["result.confirm"]));
    expect(download).toBeEnabled();
    await user.click(download);

    expect(downloads).toHaveLength(1);
    const text = await downloads[0]!.text();
    expect(text).toBe(
      [
        "Lärare;Ämne;Klass;Notis",
        'NAMN-0001;Svenska;7A;"NAMN-0002 är sjuk, ring TEL-0001"',
        "NAMN-0003;Matte;7B;Se epost-0001@exempel.invalid",
        "NAMN-0001;Svenska;7B;Byt sal i morgon",
        "NAMN-0004;Engelska;8A;Prov på fredag",
      ].join("\r\n") + "\r\n",
    );
  });

  it("names the safe file as the person says, and not after the original, which can hold a name", async () => {
    const user = setup();
    await addFile(user, csv("Anna Svensson 19800101-1234.csv", FILE));
    await user.selectOptions(await screen.findByLabelText(sv["col.choiceLabel"].replace("{n}", "4")), "keep");
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    const result = await screen.findByRole("region", { name: sv["result.heading"] });
    const name = within(result).getByLabelText(sv["result.fileName"].replace("{n}", "1")) as HTMLInputElement;
    expect(name.value).toMatch(/^exempelfil-\d+\.csv$/);
    expect(name.value).not.toMatch(/Anna|Svensson|1980/);
  });

  it("hands out the report as text with no original value in it", async () => {
    const user = setup();
    const result = await runFile(user);
    await user.click(within(result).getByLabelText(sv["result.confirm"]));
    await user.click(within(result).getByRole("button", { name: sv["result.downloadReport"] }));
    const report = await downloads[0]!.text();
    expect(report).toContain(sv["report.title"]);
    for (const original of ["Svensson", "Anna", "070-123", "skola.se", "Lind", "lektioner"]) expect(report, original).not.toContain(original);
    // Four names in the column, and Anna once more in a comment: five occurrences of four different names.
    expect(report).toContain("namn: 5 förekomster, 4 olika värden");
  });

  it("drops the result, and the confirmation with it, when anything that would change it is changed", async () => {
    const user = setup();
    const result = await runFile(user);
    await user.click(within(result).getByLabelText(sv["result.confirm"]));
    await user.selectOptions(screen.getByLabelText(sv["col.choiceLabel"].replace("{n}", "3")), "clear");
    expect(screen.queryByRole("region", { name: sv["result.heading"] })).not.toBeInTheDocument();
    // Run again: the confirmation has to be given again.
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    const again = await screen.findByRole("region", { name: sv["result.heading"] });
    expect(within(again).getByLabelText(sv["result.confirm"])).not.toBeChecked();
  });

  it("takes the user's own words and replaces them wherever they stand", async () => {
    const user = setup();
    await addFile(user, csv("lektioner.csv", FILE));
    await user.selectOptions(await screen.findByLabelText(sv["col.choiceLabel"].replace("{n}", "4")), "keep");
    await user.type(screen.getByLabelText(sv["tool.wordsLabel"]), "Matte\nProv");
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    const result = await screen.findByRole("region", { name: sv["result.heading"] });
    const preview = within(result).getAllByRole("table").at(-1)!;
    expect(preview).not.toHaveTextContent("Matte");
    expect(preview).not.toHaveTextContent("Prov");
  });

  it("clears everything at once, files, words and result", async () => {
    const user = setup();
    await runFile(user);
    await user.click(screen.getByRole("button", { name: sv["tool.clearAll"] }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: sv["result.heading"] })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: sv["tool.run"] })).not.toBeInTheDocument();
  });

  // "Rensa allt" drops what the page holds. Text pasted and not yet added is held too, and before a file is added the button used to be missing.
  describe("clears what the page holds even when no file is added", () => {
    const clearAll = () => screen.queryAllByRole("button", { name: sv["tool.clearAll"] });

    it("text in the paste box: the button is there as soon as there is text, and empties the box", async () => {
      const user = setup();
      expect(clearAll()).toHaveLength(0);
      await user.click(screen.getByLabelText(sv["tool.pasteLabel"]));
      await user.paste("Lärare\tKlass\nAnna Svensson\t7A\n");
      expect(clearAll()).toHaveLength(1);
      await user.click(clearAll()[0]!);
      expect(screen.getByLabelText(sv["tool.pasteLabel"])).toHaveValue("");
      expect(clearAll()).toHaveLength(0);
    });

    it("is one button, not two, once a file is added and the paste box still has text", async () => {
      const user = setup();
      await user.click(screen.getByLabelText(sv["tool.pasteLabel"]));
      await user.paste("Anna Svensson");
      await addFile(user, csv("lektioner.csv", FILE));
      await screen.findByRole("button", { name: sv["tool.run"] });
      expect(clearAll()).toHaveLength(1);
      await user.click(clearAll()[0]!);
      expect(screen.getByLabelText(sv["tool.pasteLabel"])).toHaveValue("");
    });

    it("the message about a file that could not be read, which names the file: the button drops it", async () => {
      const user = setup();
      await addFile(user, csv("tom-lista.csv", ""));
      expect(await screen.findByRole("alert")).toHaveTextContent("tom-lista.csv");
      expect(clearAll()).toHaveLength(1);
      await user.click(clearAll()[0]!);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("the user's own words, kept in the page after the last file is taken away: the button is there and drops them", async () => {
      const user = setup();
      await addFile(user, csv("lektioner.csv", FILE));
      await user.type(await screen.findByLabelText(sv["tool.wordsLabel"]), "Matte");
      await user.click(screen.getByRole("button", { name: new RegExp(`^${sv["file.remove"]}\\s*lektioner\\.csv$`) }));
      expect(screen.queryByLabelText(sv["tool.wordsLabel"])).not.toBeInTheDocument();
      expect(clearAll()).toHaveLength(1);
      await user.click(clearAll()[0]!);
      await addFile(user, csv("lektioner.csv", FILE));
      expect(await screen.findByLabelText(sv["tool.wordsLabel"])).toHaveValue("");
    });
  });
});

/*
 * The page's language is sv (or en), and a browser's translation service offers to translate a page that says so to its reader: it then sends what is on the page to
 * a server. "Ingen server ser den" holds only if the file's own text is marked `translate="no"` wherever the page shows it (the review of #398). The test finds every element whose
 * own text holds a probe taken from the file and asks for an ancestor that says so, so a copy of the page without the attribute fails it.
 */
describe("what a translating browser is not given: the file's own text", () => {
  /** The elements that show `probe` as their own text, and whether each is inside something marked translate="no". */
  const shown = (probe: string | RegExp) => screen.queryAllByText(probe, { exact: false }).map((element) => ({ element, marked: element.closest('[translate="no"]') !== null }));
  const expectMarked = (probe: string | RegExp, where: string) => {
    const found = shown(probe);
    expect(found.length, `${where}: nothing on the page shows ${String(probe)}`).toBeGreaterThan(0);
    for (const { element, marked } of found) expect(marked, `${where}: <${element.tagName.toLowerCase()}> "${element.textContent}" is offered to a translator`).toBe(true);
  };

  it("on the file's card: its name, a column's header, the example cells and the header row's cells in the list of rows", async () => {
    const user = setup();
    await addFile(user, csv("lektioner-åk7.csv", FILE));
    await screen.findByRole("table", { name: sv["col.caption"].replace("{n}", "1") });
    expectMarked("lektioner-åk7.csv", "the file's name");
    expectMarked("Notis", "a column's header");
    expectMarked("Prov på fredag", "an example cell");
    expectMarked("Lärare · Ämne", "the cells of a row in the list of header rows");
  });

  it("in the result: the cells of the safe file's preview, and the report shown on the page", async () => {
    const user = setup();
    await runFile(user);
    expectMarked("Prov på fredag", "a cell of the preview");
    expectMarked("Svenska", "a cell of the preview");
    // The report names the columns by their headers as they stand in the safe file.
    expectMarked(/Kolumn 4 \(Notis\)/, "the report shown on the page");
  });

  it("for a file that is not a table: its lines in the preview", async () => {
    const user = setup();
    await addFile(user, csv("brev.txt", "Kära Anna,\nVi ses kl 8, och sen, kanske\nHälsningar\n"));
    await user.click(await screen.findByRole("button", { name: sv["tool.run"] }));
    await screen.findByRole("region", { name: sv["result.heading"] });
    expectMarked(/Vi ses kl 8/, "a line of the preview");
  });

  it("marks nothing else on the page: the page's own sentences stay translatable", async () => {
    const user = setup();
    await runFile(user);
    for (const label of [sv["tool.addHeading"], sv["result.heading"], sv["result.previewHeading"]]) {
      const found = shown(label);
      expect(found.length, label).toBeGreaterThan(0);
      for (const { element, marked } of found) expect(marked, `${label} (<${element.tagName.toLowerCase()}>)`).toBe(false);
    }
  });
});

describe("the tool asks where it cannot tell", () => {
  it("says when the row taken for the header is a record, with the way out, and not when it is a header", async () => {
    const user = setup();
    await addFile(user, csv("poster.csv", "Mån;08:10;Anna Exempel;7A\nTis;09:00;Bo Prov;7B\nOns;10:00;Cia Test;7C\n"));
    expect(await screen.findByText(/Rad 1 ser ut som en post och inte som en rubrik/)).toBeInTheDocument();
    cleanup();
    const again = setup();
    await addFile(again, csv("lektioner.csv", FILE));
    await screen.findByRole("table", { name: sv["col.caption"].replace("{n}", "1") });
    expect(screen.queryByText(/ser ut som en post och inte som en rubrik/)).not.toBeInTheDocument();
  });

  it("asks about a column of dates that spans years, with what it saw, instead of keeping it as numbers", async () => {
    const user = setup();
    await addFile(user, csv("elever.csv", "Klass;F-datum\n7A;2010-03-04\n7A;2011-11-30\n7B;2012-07-01\n7B;2013-01-22\n"));
    const columns = await screen.findByRole("table", { name: sv["col.caption"].replace("{n}", "1") });
    expect(within(columns).getByText(/datum över \d+ dagar: kan vara födelsedatum/)).toBeInTheDocument();
    expect(within(columns).getByText(sv["proposal.none"])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: sv["tool.run"] })).toBeDisabled();
  });

  it("says in the result that the check searches as the tool does, and lists the short names it does not look for", async () => {
    const user = setup();
    const result = await runFile(user);
    expect(within(result).getByText(/samma sätt som verktyget själv/)).toBeInTheDocument();
    expect(within(result).getAllByText(/färre än tre bokstäver/).length).toBeGreaterThanOrEqual(1);
  });
});

describe("the tool, other kinds of input", () => {
  it("reads a table pasted from a spreadsheet, tab-separated, and calls it that", async () => {
    const user = setup();
    await user.click(screen.getByLabelText(sv["tool.pasteLabel"]));
    await user.paste("Lärare\tKlass\nAnna Svensson\t7A\nBo Ek\t7B\n");
    await user.click(screen.getByRole("button", { name: sv["tool.addPaste"] }));
    expect(await screen.findByRole("heading", { name: `Fil 1: ${sv["tool.pastedName"]}` })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    const result = await screen.findByRole("region", { name: sv["result.heading"] });
    expect(within(result).getAllByRole("table").at(-1)).toHaveTextContent("NAMN-0001");
  });

  it("reads a workbook, a sheet to a file, and counts the hidden sheet it did not read", async () => {
    const user = setup();
    const book = await makeXlsx({
      sheets: [
        { name: "Lektioner", rows: [["Lärare", "Klass"], ["Anna Svensson", "7A"]] },
        { name: "Dolt", hidden: true, rows: [["hemligt"]] },
      ],
      author: "Fiktiv Författare",
    });
    await addFile(user, new File([book as unknown as BlobPart], "schema.xlsx"));
    expect(await screen.findByRole("heading", { name: /Fil 1: schema\.xlsx, Lektioner/ })).toBeInTheDocument();
    expect(screen.getByText(/1 dolt blad lästes inte/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    const result = await screen.findByRole("region", { name: sv["result.heading"] });
    await user.click(within(result).getByLabelText(sv["result.confirm"]));
    await user.click(within(result).getByRole("button", { name: sv["result.downloadFile"].replace("{n}", "1") }));
    const text = await downloads[0]!.text();
    expect(text).toBe("Lärare;Klass\r\nNAMN-0001;7A\r\n");
    expect(text).not.toContain("Fiktiv");
  });

  it("says why a file cannot be made safe, by what it is and not by its name, and adds nothing for it", async () => {
    const user = setup();
    const access = new Uint8Array([0x00, 0x01, 0x00, 0x00, ...new TextEncoder().encode("Standard Jet DB"), ...new Array(60).fill(0)]);
    await addFile(user, new File([access], "export.csv"));
    expect(await screen.findByRole("alert")).toHaveTextContent("export.csv: " + sv["problem.access"]);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says it in English in English", async () => {
    const en = flattenLabels(enMessages.pseudonymiserare) as Labels;
    const user = setup(en, "en");
    await user.click(screen.getByLabelText(en["tool.pasteLabel"]));
    await user.paste("Teacher\tClass\nAnna Svensson\t7A\n");
    await user.click(screen.getByRole("button", { name: en["tool.addPaste"] }));
    expect(await screen.findByRole("heading", { name: `File 1: ${en["tool.pastedName"]}` })).toBeInTheDocument();
    expect(screen.getByText(/2 rows, 2 columns/)).toBeInTheDocument();
  });

  it("runs a school's size of file through the page in a few seconds", async () => {
    const rows = ["Lärare;Ämne;Klass;Personnummer"];
    for (let i = 0; i < 3000; i += 1) rows.push(`Lärare ${i % 90};Svenska;7${"ABC"[i % 3]};19${70 + (i % 30)}0101-${String(1000 + (i % 9000))}`);
    const user = setup();
    await addFile(user, csv("stor.csv", rows.join("\n") + "\n"));
    await user.click(await screen.findByRole("button", { name: sv["tool.run"] }));
    const result = await screen.findByRole("region", { name: sv["result.heading"] }, { timeout: 30_000 });
    expect(within(result).getByText(sv["result.checkPassed"])).toBeInTheDocument();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Nothing leaves the browser
// ---------------------------------------------------------------------------

describe("every way out of the page is replaced by a trap, and the whole flow never touches one", () => {
  /** A function that says it was called, and throws so that the page would show it. */
  const trap = (name: string, calls: string[]) =>
    function (this: unknown) {
      calls.push(name);
      throw new Error(`${name} was called`);
    };

  it("makes no request, opens no socket or worker, sets no cookie, stores nothing, navigates nowhere", async () => {
    const calls: string[] = [];
    const t = (name: string) => trap(name, calls);

    vi.stubGlobal("fetch", t("fetch"));
    vi.stubGlobal("XMLHttpRequest", class { constructor() { t("XMLHttpRequest")(); } });
    vi.stubGlobal("WebSocket", class { constructor() { t("WebSocket")(); } });
    vi.stubGlobal("EventSource", class { constructor() { t("EventSource")(); } });
    vi.stubGlobal("Worker", class { constructor() { t("Worker")(); } });
    vi.stubGlobal("SharedWorker", class { constructor() { t("SharedWorker")(); } });
    vi.stubGlobal("Image", class { constructor() { t("Image")(); } });
    vi.stubGlobal("BroadcastChannel", class { constructor() { t("BroadcastChannel")(); } });
    vi.stubGlobal("indexedDB", { open: t("indexedDB.open") });
    Object.defineProperty(navigator, "sendBeacon", { value: t("sendBeacon"), configurable: true });
    vi.spyOn(window, "open").mockImplementation(t("window.open") as never);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(t("Storage.setItem") as never);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(t("Storage.getItem") as never);
    vi.spyOn(Document.prototype, "cookie", "set").mockImplementation(t("document.cookie") as never);
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(t("form.submit") as never);

    const user = setup();
    const result = await runFile(user);
    await user.click(within(result).getByLabelText(sv["result.confirm"]));
    await user.click(within(result).getByRole("button", { name: sv["result.downloadFile"].replace("{n}", "1") }));
    await user.click(within(result).getByRole("button", { name: sv["result.downloadReport"] }));
    await user.click(screen.getByRole("button", { name: sv["tool.clearAll"] }));

    // A file was handed out, twice (the file and the report), and that is all that happened.
    expect(downloads).toHaveLength(2);
    expect(calls).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
  });

  it("has no link or form on it that leaves the page, and no frame, script or picture of its own", () => {
    setup();
    for (const anchor of document.querySelectorAll("a")) expect(anchor.getAttribute("href") ?? "", "a").toBe("");
    expect(document.querySelectorAll("form, iframe, script, img, link, embed, object").length).toBe(0);
  });
});
