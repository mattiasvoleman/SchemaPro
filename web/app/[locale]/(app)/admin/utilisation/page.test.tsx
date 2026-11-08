import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { bucket, report, row } from "@/lib/__fixtures__/local";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import UtilisationPage from "./page";

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Utnyttjande, the administrator's page (/admin/utilisation), through the gateway's route and the real messages.
 *
 * What this guards: the page opens on the term it is in and asks the gateway for it, and only when "Visa" is
 * pressed for anything else, since a term across every room is a heavy read; the shares are the gateway's and a
 * share that has no time to divide by is a dash and not a zero; a week-by-week row opens under each room and
 * resource; a period or hours the gateway would refuse are refused before they are sent, naming the field;
 * a school with no ramtider is told so; a failed read is said as such; and the report goes to a file and to paper.
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
const download = vi.hoisted(() => vi.fn());
vi.mock("@/lib/local-queries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/local-queries")>()), downloadUtilisationCsv: download }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state = vi.hoisted(() => ({ report: undefined as unknown, error: false }));

const NBSP = "\u0020";
const SPRING = "/api/v1/utilisation?from=2027-01-01&to=2027-07-31&kind=ALL&openFrom=07%3A00&openTo=22%3A00";
const reads = () => api.get.mock.calls.map(([path]) => String(path));

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
        <UtilisationPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The page opens on the term it is in: the day is fixed, and only the clock's date is, so timers run as they do.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-02-02T10:00:00Z"));
  state.report = report();
  state.error = false;
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/utilisation?")) {
      if (state.error) throw new ApiError(500, "boom");
      return state.report;
    }
    throw new Error(`unexpected read ${path}`);
  });
  download.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

const table = async () => within(await screen.findByRole("table", { name: "Utnyttjande per sal och resurs" }));
const rowOf = async (name: string) => (await table()).getByRole("row", { name: new RegExp(name) });

describe("Utnyttjande, the report", () => {
  it("is busy until the report is read, then asks for the term it is in, with the usual open hours", async () => {
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await table();
    expect(reads()).toEqual([SPRING]);
    expect(screen.getByRole("heading", { level: 1, name: "Utnyttjande" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("2027-spring");
    expect(screen.getByRole("textbox", { name: "Från" })).toHaveValue("2027-01-01");
    expect(screen.getByRole("textbox", { name: "Till" })).toHaveValue("2027-07-31");
    expect(screen.getByLabelText("Öppnar")).toHaveValue("07:00");
    expect(screen.getByLabelText("Stänger")).toHaveValue("22:00");
    expect(screen.getByText("Rapporten visar 2 salar och resurser.")).toHaveAttribute("role", "status");
  });

  it("draws each room and resource with its booked hours, its shares, and a dash where there is no school time", async () => {
    renderPage();
    const gym = await rowOf("Gymnastiksalen");
    expect(gym).toHaveTextContent("Sal");
    expect(gym).toHaveTextContent("50 av 100 tim");
    expect(gym).toHaveTextContent(`50${NBSP}%`);
    expect(gym).toHaveTextContent("20 av 200 tim");
    expect(gym).toHaveTextContent(`10${NBSP}%`);

    const tablets = await rowOf("Surfplattor klass 7");
    expect(tablets).toHaveTextContent("Resurs");
    expect(tablets).toHaveTextContent("enhetstimmar");
    // No school time to divide by: a dash, never 0 %.
    expect(tablets).toHaveTextContent("–");
    expect(tablets).toHaveTextContent(`2,5${NBSP}%`);
  });

  it("opens the weeks of a room under it and closes them, and says so to a screen reader", async () => {
    const user = userEvent.setup();
    renderPage();
    const toggle = await screen.findByRole("button", { name: "Visa veckorna för Gymnastiksalen" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    await user.click(toggle);

    const open = screen.getByRole("button", { name: "Dölj veckorna för Gymnastiksalen" });
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(open.getAttribute("aria-controls")?.split(" ")).toHaveLength(2);
    const week = await rowOf("v. 5");
    expect(week).toHaveTextContent("v. 5, mån 1 feb. 2027");
    expect(week).toHaveTextContent("10 av 25 tim");
    expect(week).toHaveTextContent(`40${NBSP}%`);
    expect(await rowOf("v. 6")).toHaveTextContent(`60${NBSP}%`);

    await user.click(open);
    expect(screen.queryByRole("row", { name: /v\. 5/ })).not.toBeInTheDocument();
  });

  it("opens every row's weeks at once, and closes them again", async () => {
    const user = userEvent.setup();
    renderPage();
    await table();
    await user.click(screen.getByRole("button", { name: "Visa alla veckor" }));
    expect(screen.getAllByRole("row", { name: /v\. 5/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Dölj alla veckor" }));
    expect(screen.queryByRole("row", { name: /v\. 5/ })).not.toBeInTheDocument();
  });

  it("explains how it counts, in the page, so the printout carries it", async () => {
    renderPage();
    await table();
    expect(screen.getByText("Så räknas det")).toBeInTheDocument();
    expect(screen.getByText(/Skoltid är tiden inom skolans ramtider på läsdagar/)).toBeInTheDocument();
    expect(screen.getByText(/öppettiderna \(07:00–22:00\) som ligger utanför skoltid/)).toBeInTheDocument();
    expect(screen.getByText(/En bokning som väntar på beslut räknas inte/)).toBeInTheDocument();
  });

  it("tells a school with no ramtider that there is no school time to share, and still draws the rest", async () => {
    state.report = report({ framesMissing: true, rows: [row({ total: bucket({ schoolMinutes: 0, bookedSchoolMinutes: 0, schoolShare: null }), weeks: [] })] });
    renderPage();
    expect(await screen.findByText("Skolan har inga ramtider")).toBeInTheDocument();
    expect(screen.getByText(/Utan ramtider finns ingen skoltid att mäta mot/)).toBeInTheDocument();
    expect(await rowOf("Gymnastiksalen")).toHaveTextContent("0 av 0 tim");
    expect(await rowOf("Gymnastiksalen")).toHaveTextContent("–");
  });

  it("says there is nothing to show when the type has no rooms or resources", async () => {
    state.report = report({ rows: [] });
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Inga salar eller resurser att visa" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skriv ut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Visa alla veckor" })).toBeDisabled();
    expect(screen.getByText("Rapporten har inga rader.")).toHaveAttribute("role", "status");
  });

  it("says a failed read is a failed read and can be tried again", async () => {
    state.error = true;
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Rapporten kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga salar eller resurser att visa")).not.toBeInTheDocument();
    state.error = false;
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    await table();
  });

  it("is in English too, with terms and shares written the English way", async () => {
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "Utilisation" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("2027-spring");
    expect(screen.getByRole("option", { name: "Autumn term 2027" })).toBeInTheDocument();
    const gym = (await screen.findByRole("table", { name: "Utilisation per room and resource" })).querySelector("tbody tr")!;
    expect(gym).toHaveTextContent("50 of 100 h");
    expect(gym).toHaveTextContent("50%");
  });
});

describe("Utnyttjande, the form", () => {
  it("offers last year's terms, this year's and next year's, and the dates the reader writes", async () => {
    renderPage();
    await table();
    const options = within(screen.getByRole("combobox", { name: "Period" })).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Vårtermin 2026",
      "Hösttermin 2026",
      "Vårtermin 2027",
      "Hösttermin 2027",
      "Vårtermin 2028",
      "Hösttermin 2028",
      "Egna datum",
    ]);
  });

  it("asks for nothing until Visa is pressed, then for what the preset says", async () => {
    const user = userEvent.setup();
    renderPage();
    await table();
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "2027-autumn");
    expect(screen.getByRole("textbox", { name: "Från" })).toHaveValue("2027-08-01");
    expect(screen.getByRole("textbox", { name: "Till" })).toHaveValue("2027-12-31");
    expect(reads()).toEqual([SPRING]);

    await user.click(screen.getByRole("button", { name: "Visa" }));
    await waitFor(() => expect(reads()).toContain("/api/v1/utilisation?from=2027-08-01&to=2027-12-31&kind=ALL&openFrom=07%3A00&openTo=22%3A00"));
  });

  it("calls the dates of no term own dates", async () => {
    renderPage();
    await table();
    fireEvent.change(screen.getByRole("textbox", { name: "Från" }), { target: { value: "2027-02-01" } });
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("custom");
  });

  it("asks for rooms alone, or resources alone, and for other open hours", async () => {
    const user = userEvent.setup();
    renderPage();
    await table();
    await user.selectOptions(screen.getByRole("combobox", { name: "Typ" }), "ROOM");
    fireEvent.change(screen.getByLabelText("Öppnar"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("Stänger"), { target: { value: "21:30" } });
    await user.click(screen.getByRole("button", { name: "Visa" }));
    await waitFor(() => expect(reads()).toContain("/api/v1/utilisation?from=2027-01-01&to=2027-07-31&kind=ROOM&openFrom=08%3A00&openTo=21%3A30"));
  });

  it("closes the weeks that were open when another report is asked for", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Visa veckorna för Gymnastiksalen" }));
    await rowOf("v. 5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Typ" }), "RESOURCE");
    await user.click(screen.getByRole("button", { name: "Visa" }));
    await waitFor(() => expect(screen.queryByRole("row", { name: /v\. 5/ })).not.toBeInTheDocument());
  });

  it("refuses hours that run backwards, a period the gateway would refuse and a date that is none, naming each field and asking nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    await table();
    fireEvent.change(screen.getByLabelText("Öppnar"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("Stänger"), { target: { value: "07:00" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Till" }), { target: { value: "2028-06-01" } });
    await user.click(screen.getByRole("button", { name: "Visa" }));

    const alert = within(screen.getByRole("alert"));
    expect(alert.getByText(/Till: Perioden får vara högst 400 dagar\./)).toBeInTheDocument();
    expect(alert.getByText(/Stänger: Stängningstiden måste vara efter öppningstiden\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Stänger")).toBeInvalid();
    expect(reads()).toEqual([SPRING]);

    fireEvent.change(screen.getByRole("textbox", { name: "Från" }), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Visa" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Från: Skriv datumet som åååå-mm-dd.");
    expect(reads()).toEqual([SPRING]);
  });

  it("says nothing of an error before the first attempt", async () => {
    renderPage();
    await table();
    fireEvent.change(screen.getByLabelText("Öppnar"), { target: { value: "23:00" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Utnyttjande, on paper and as a file", () => {
  it("hides the controls from paper and gives the printout a heading of its own with the period", async () => {
    renderPage();
    await table();
    expect(screen.getByLabelText("Öppnar").closest("form")).toHaveClass("print:hidden");
    const heading = screen.getByRole("heading", { level: 2, name: /Rastra Utnyttjande · 2027-01-01 – 2027-07-31/, hidden: true });
    expect(heading).toHaveClass("hidden", "print:block");
    expect(screen.getByRole("button", { name: "Skriv ut" }).parentElement).toHaveClass("print:hidden");
  });

  it("prints", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const user = userEvent.setup();
    renderPage();
    await table();
    await user.click(screen.getByRole("button", { name: "Skriv ut" }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  it("downloads the report that is on screen, not the form that is being typed", async () => {
    const user = userEvent.setup();
    renderPage();
    await table();
    await user.selectOptions(screen.getByRole("combobox", { name: "Typ" }), "RESOURCE");
    await user.click(screen.getByRole("button", { name: "Ladda ned CSV" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download).toHaveBeenCalledWith({ from: "2027-01-01", to: "2027-07-31", kind: "ALL", openFrom: "07:00", openTo: "22:00" });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says in the reader's language that the file could not be downloaded, and the page stands", async () => {
    download.mockRejectedValueOnce(new ApiError(500, "boom"));
    const user = userEvent.setup();
    renderPage();
    await table();
    await user.click(screen.getByRole("button", { name: "Ladda ned CSV" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Filen kunde inte laddas ned. Försök igen om en stund."));
    expect(await table()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ladda ned CSV" })).toBeEnabled();
  });

  it("downloads once however often the button is pressed while the file is on its way", async () => {
    let release!: () => void;
    download.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    const user = userEvent.setup();
    renderPage();
    await table();
    const button = screen.getByRole("button", { name: "Ladda ned CSV" });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    release();
    await waitFor(() => expect(button).toBeEnabled());
    expect(download).toHaveBeenCalledTimes(1);
  });
});
