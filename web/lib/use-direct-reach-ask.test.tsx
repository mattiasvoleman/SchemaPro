import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError } from "@/lib/api";
import { DIRECT_REACH_UNANSWERED, DirectReachDeclined, type DirectReach } from "@/lib/direct-reach";
import { useDirectReachAsk } from "@/lib/use-direct-reach-ask";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/*
 * The question before a change in Direkt that reaches families (P5, beslut 8), as a page uses it: ask(run) around a write, question
 * rendered once. The school is asked before the write when the gateway's state says so, once, and the write is run only after an answer.
 */

const YEAR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const asked: DirectReach = {
  academicYearId: YEAR,
  mode: "DIRECT",
  period: { from: "2026-08-01", to: "2027-06-11" },
  acknowledgedAt: null,
  ask: true,
  audience: { pupils: 412, guardians: 689 },
};
const answered: DirectReach = { ...asked, ask: false, audience: null, acknowledgedAt: "2026-08-02T10:00:00.000Z" };

type Ask = ReturnType<typeof useDirectReachAsk>["ask"];
let ask: Ask;

function Harness() {
  const reach = useDirectReachAsk();
  ask = reach.ask;
  return <>{reach.question}</>;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <Harness />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return client;
}

/** The gateway: the state the page reads, in the order it is read, and what the two answers post. */
function gateway(states: Array<DirectReach | Error>, posts: Record<string, unknown> = {}) {
  let read = 0;
  api.get.mockImplementation(async () => {
    const next = states[Math.min(read, states.length - 1)]!;
    read += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  api.post.mockImplementation(async (path: string) => {
    if (path in posts) return posts[path];
    throw new Error(`unexpected POST ${path}`);
  });
}

// The dialog is its own chunk, fetched by the first question: the first import() transforms radix and the dialog, and the tests wait for that
// here and not in whichever test asks first.
beforeAll(async () => {
  await import("@/components/publication/direct-reach-dialog");
}, 60_000);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe("useDirectReachAsk", () => {
  it("runs the write at once, and asks nothing, when the school has answered or nothing is published", async () => {
    gateway([answered]);
    mount();
    const run = vi.fn().mockResolvedValue("saved");
    await expect(act(() => ask(run))).resolves.toBe("saved");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before the write, says who gets the notice and how many, and runs the write only after Fortsätt i Direkt", async () => {
    gateway([asked], { "/api/v1/publication-settings/direct-reach/acknowledge": answered });
    mount();
    const run = vi.fn().mockResolvedValue("saved");
    let outcome: Promise<unknown> | undefined;
    await act(async () => {
      outcome = ask(run);
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Ändringen når familjerna direkt");
    expect(dialog.textContent).toContain("publicerat 2026-08-01–2027-06-11");
    expect(dialog.textContent).toContain("får eleverna i den och deras vårdnadshavare en notis");
    expect(dialog.textContent).toContain("412 elever och 689 vårdnadshavare");
    expect(run).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Fortsätt i Direkt" }));
    await expect(outcome).resolves.toBe("saved");
    expect(api.post).toHaveBeenCalledWith("/api/v1/publication-settings/direct-reach/acknowledge", { academicYearId: YEAR });
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Answered: the next write is not asked.
    await act(() => ask(run));
    expect(run).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("runs nothing and fails with DirectReachDeclined when the reader says Avbryt", async () => {
    gateway([asked]);
    mount();
    const run = vi.fn();
    let outcome: Promise<unknown> | undefined;
    await act(async () => {
      outcome = ask(run);
      outcome.catch(() => undefined);
    });
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    await expect(outcome).rejects.toBeInstanceOf(DirectReachDeclined);
    expect(run).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("switches the school to utkast on Använd utkast and then runs the write, which no longer reaches anybody", async () => {
    gateway([asked], { "/api/v1/publication-settings/mode": { publishMode: "DRAFT", baselines: [] } });
    mount();
    const run = vi.fn().mockResolvedValue("saved");
    let outcome: Promise<unknown> | undefined;
    await act(async () => {
      outcome = ask(run);
    });
    await userEvent.click(await screen.findByRole("button", { name: "Använd utkast" }));
    await expect(outcome).resolves.toBe("saved");
    expect(api.post).toHaveBeenCalledWith("/api/v1/publication-settings/mode", { publishMode: "DRAFT" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks anyway when the gateway refuses a write the page thought was fine (a second tab, a stale state), and runs it again once", async () => {
    // The page read "answered"; the gateway's guard said otherwise, and the state read again says to ask.
    gateway([answered, asked], { "/api/v1/publication-settings/direct-reach/acknowledge": answered });
    mount();
    const refusal = new ApiError(409, "Ändringen når elever och vårdnadshavare", DIRECT_REACH_UNANSWERED, { validFrom: "2026-08-01", validTo: "2027-06-11" });
    const run = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce("saved");
    let outcome: Promise<unknown> | undefined;
    await act(async () => {
      outcome = ask(run);
    });
    await userEvent.click(await screen.findByRole("button", { name: "Fortsätt i Direkt" }));
    await expect(outcome).resolves.toBe("saved");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves every other failure of the write as it was, asked about nothing", async () => {
    gateway([answered]);
    mount();
    const other = new ApiError(409, "Schemakonflikt", "MASTER_LESSON_REFUSED");
    const run = vi.fn().mockRejectedValue(other);
    await expect(act(() => ask(run))).rejects.toBe(other);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // A refusal that the gateway keeps even though the state now says no question is the gateway's to say: it is not hidden.
    const refusal = new ApiError(409, "x", DIRECT_REACH_UNANSWERED);
    const again = vi.fn().mockRejectedValue(refusal);
    await expect(act(() => ask(again))).rejects.toBe(refusal);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the state cannot be read: the gateway holds the line, and says it if the write reached families", async () => {
    gateway([new Error("offline")]);
    mount();
    const run = vi.fn().mockResolvedValue("saved");
    await expect(act(() => ask(run))).resolves.toBe("saved");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
