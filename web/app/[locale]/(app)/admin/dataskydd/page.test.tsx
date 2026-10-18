import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { RetentionKind, RetentionOverview } from "@/lib/retention-types";
import { RETENTION_DATA_TYPES } from "@/lib/retention-types";
import DataProtectionPage from "./page";

/**
 * /admin/dataskydd over the real hooks and the real Swedish messages (an
 * untranslated key or an unfilled ICU argument throws), with the gateway
 * answering by path. What only this page decides: that every kind starts
 * "Ej beslutat" and says nothing will go, what a period would take before
 * it is saved, that a choice which takes something is said to be
 * irreversible and saved with the destructive button, one decision per
 * kind with months only for a period, a refusal's sentence, and the runs as
 * counts.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const undecided = (): RetentionKind[] =>
  RETENTION_DATA_TYPES.map((dataType) => ({ dataType, current: null, waitsUntil: null, preview: null, purgedBefore: null }));

const overview = (patch: Partial<RetentionOverview> = {}): RetentionOverview => ({
  timezone: "Europe/Stockholm",
  nightlyHour: 3,
  kinds: undecided(),
  runs: [],
  history: [],
  ...patch,
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <DataProtectionPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const row = (name: string) => screen.getByRole("button", { name: `Ändra gallringsperioden för ${name}` }).closest("li")!;

describe("/admin/dataskydd", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/retention") return overview();
      // The read log's picker (access-log-card.test.tsx has its own cases).
      if (path === "/api/v1/users") return [];
      if (path.startsWith("/api/v1/retention/preview")) {
        const months = Number(new URLSearchParams(path.split("?")[1]).get("months"));
        return { cutoff: months === 12 ? "2025-10-21" : "2026-04-21", due: months === 12 ? 1234 : 0, held: 0 };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it("starts every kind at Ej beslutat, and says a purge cannot be undone before anything else", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Dataskydd och gallring" })).toBeInTheDocument();
    expect(screen.getByText("En gallring går inte att ångra i Rastra Schema")).toBeInTheDocument();
    expect(screen.getByText(/Rastra Schema gör ännu inga arkivuttag/)).toBeInTheDocument();
    await screen.findByRole("button", { name: "Ändra gallringsperioden för Närvaro" });
    for (const name of ["Närvaro", "Frånvaroanmälningar", "Ledighetsansökningar", "Notiser", "Ändringsloggar", "Frånvaroorsaker", "Läslogg", "Slutade personer"]) {
      expect(within(row(name)).getByText("Ej beslutat")).toBeInTheDocument();
    }
    expect(screen.getByText("Ingen gallring har körts än.")).toBeInTheDocument();
    expect(screen.getByText("Inga beslut än. Allt sparas tills ett beslut finns.")).toBeInTheDocument();
  });

  it("counts what a period would take before it is saved, warns that it cannot be restored, and saves one decision", async () => {
    const decided: RetentionOverview = overview({
      kinds: undecided().map((kind) =>
        kind.dataType === "ATTENDANCE"
          ? {
              ...kind,
              current: { dataType: "ATTENDANCE", decision: "PURGE_AFTER", months: 12, reference: "DHP 4.1", decidedAt: "2026-10-21T09:00:00Z", decidedBy: "Ada Rektor" },
              waitsUntil: "2026-10-23",
              preview: { cutoff: "2025-10-21", due: 1234, held: 0 },
            }
          : kind,
      ),
    });
    post.mockResolvedValue(decided);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ändra gallringsperioden för Närvaro" }));
    const dialog = await screen.findByRole("dialog", { name: "Närvaro: hur länge sparas det?" });
    expect(within(dialog).getByText("Inget gallras så länge inget är beslutat.")).toBeInTheDocument();
    // Nothing chosen yet is nothing to save.
    expect(within(dialog).getByRole("button", { name: "Spara beslut" })).toBeDisabled();

    await user.selectOptions(within(dialog).getByLabelText("Beslut"), "12");
    expect(await within(dialog).findByText(/I dag är 1\s234 poster daterade före 21 oktober 2025/)).toBeInTheDocument();
    expect(within(dialog).getByText("Det som gallras kan inte återställas")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Referens i dokumenthanteringsplanen/), "DHP 4.1");
    await user.click(within(dialog).getByRole("button", { name: "Spara beslut" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/retention/decisions", { dataType: "ATTENDANCE", decision: "PURGE_AFTER", months: 12, reference: "DHP 4.1" });
    expect(toast.success).toHaveBeenCalledWith("Beslutet är sparat.");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The page as the gateway answered: the period, who and when, the night it starts, what it takes.
    const attendance = row("Närvaro");
    expect(within(attendance).getByText("Gallras efter 1 år")).toBeInTheDocument();
    expect(within(attendance).getByText(/Beslutat 21 oktober 2026 kl\. 11:00 av Ada Rektor · Referens: DHP 4\.1/)).toBeInTheDocument();
    expect(within(attendance).getByText("Börjar gälla natten mot 23 oktober 2026. Fram till dess gäller det tidigare beslutet.")).toBeInTheDocument();
    expect(within(attendance).getByText(/1\s234 poster är daterade före 21 oktober 2025 och gallras vid nästa körning/)).toBeInTheDocument();
  });

  it("saves Bevaras without months and with the ordinary button, and shows a refusal where it was pressed", async () => {
    post.mockRejectedValueOnce(new ApiError(403, "no", "RETENTION_PREVIEW_IS_THE_ADMINS"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Ändra gallringsperioden för Slutade personer" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Beslut"), "KEEP");
    expect(within(dialog).getByText("Inget gallras. Beslutet sparas i historiken.")).toBeInTheDocument();
    expect(within(dialog).queryByText("Det som gallras kan inte återställas")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Spara beslut" }));
    expect(post).toHaveBeenCalledWith("/api/v1/retention/decisions", { dataType: "DEPARTED_PEOPLE", decision: "KEEP" });
    expect(await within(dialog).findByText("Bara skolans administratör ser och bestämmer gallringen.")).toBeInTheDocument();
    // The people's choices are written as pseudonymisation.
    expect(within(dialog).getByRole("option", { name: "Pseudonymiseras efter 1 år" })).toBeInTheDocument();
  });

  it("says everything pseudonymising a person does, on the page and beside the count, own notices whatever Notiser says", async () => {
    const effects = [
      "Namn, e-post, telefon och SS12000-id ersätts.",
      "Inloggningen tas bort.",
      "Alla personens egna notiser tas bort, oavsett beslutet för Notiser. Notiser till andra som nämner personen följer det beslutet.",
      "Kopplingar mellan personen och vårdnadshavare eller elever tas bort.",
      "Personens enheter för push och val av e-post och push tas bort.",
      "Signatur och anteckning tas bort från personens tjänster. Tjänsterna finns kvar, och tidigare versioner behåller signaturen tills Ändringsloggar gallrar läsåret.",
    ];
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Ändra gallringsperioden för Slutade personer" });
    const people = row("Slutade personer");
    expect(within(people).getByText(/väntar till och med den 30 november det läsåret/)).toBeInTheDocument();
    const list = within(people).getByRole("list", { name: "När en person pseudonymiseras:" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(effects);
    // Only the people say it: no other kind's row has the list.
    expect(within(row("Notiser")).queryByRole("list")).not.toBeInTheDocument();

    await user.click(within(people).getByRole("button", { name: "Ändra gallringsperioden för Slutade personer" }));
    const dialog = await screen.findByRole("dialog");
    // Bevaras pseudonymises nobody, so says nothing of it.
    await user.selectOptions(within(dialog).getByLabelText("Beslut"), "KEEP");
    expect(within(dialog).queryByRole("list")).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Beslut"), "12");
    expect(
      await within(dialog).findByText(/1\s234 personer avaktiverades före 21 oktober 2025 och pseudonymiseras när perioden börjar gälla, som listan beskriver\./),
    ).toBeInTheDocument();
    const beside = within(dialog).getByRole("list", { name: "När en person pseudonymiseras:" });
    expect(within(beside).getAllByRole("listitem").map((item) => item.textContent)).toEqual(effects);
  });

  it("lists a night's run as counts, with what waits and what continues", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/retention")
        return overview({
          runs: [
            {
              startedAt: "2026-10-21T01:05:00Z",
              finishedAt: "2026-10-21T01:06:00Z",
              status: "DONE",
              periods: { ATTENDANCE: 12, DEPARTED_PEOPLE: 12 },
              cutoffs: { ATTENDANCE: "2025-10-21", DEPARTED_PEOPLE: "2025-10-21" },
              counts: { ATTENDANCE: 100000, DEPARTED_PEOPLE: 2 },
              complete: { ATTENDANCE: false, DEPARTED_PEOPLE: true },
              waiting: { DEPARTED_PEOPLE_SCB: 1, DEPARTED_PEOPLE_LOGIN: 1 },
            },
          ],
        });
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    const table = await screen.findByRole("table", { name: "Senaste gallringar" });
    const cells = within(table).getAllByRole("cell").map((cell) => cell.textContent ?? "");
    expect(cells).toHaveLength(4);
    expect(cells[0]).toBe("21 oktober 2026 kl. 03:05");
    expect(cells[1]).toBe("Klar");
    expect(cells[2]).toMatch(/^Närvaro 100\s000 · Slutade personer 2$/);
    expect(cells[3]).toBe(
      "1 lärare väntar på SCB-filen · 1 inloggning kunde inte tas bort och försöks igen · Närvaro fortsätter nästa natt",
    );
  });

  it("says the settings could not be read, and changes nothing", async () => {
    get.mockRejectedValue(new ApiError(500, "boom"));
    renderPage();
    expect(await screen.findByText("Gallringsinställningarna kunde inte läsas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ändra gallringsperioden/ })).not.toBeInTheDocument();
  });
});
