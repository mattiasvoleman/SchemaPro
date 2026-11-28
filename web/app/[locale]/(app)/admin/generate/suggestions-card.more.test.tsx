import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IntlMessageFormat } from "intl-messageformat";
import { cleanup, render as renderPlain, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { OptimizationJob } from "@/lib/queries";
import type { SuggestionChange, Suggestions } from "@/lib/suggestion-types";
import { SuggestionsCard } from "./suggestions-card";

/*
 * WHAT THE CARD SAYS OF THE CHANGES IT DOES NOT SHOW (omgång 13, G6 del 3, granskning). The engine's proof is for the LIST: the whole of it
 * works, and the lists it finds are what it found and "inte säkert de billigaste" (the caveat), so no change of it is shown to be NEEDED.
 * "behövs för att veckan ska gå ihop" says it is; and said under "Kan hjälpa (inte kontrollerat)", where nothing is proved at all, it
 * contradicts the line above it. The English singular also read "1 more change belong to the same solution and are needed".
 */

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    namespace === "days" ? key : values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const change = (proof: SuggestionChange["proof"]): SuggestionChange => ({
  rule: "TEACHER_DAILY_CAP", proof, cost: 168, current: 300, needed: 330, neededIsLeast: null, weekdays: [3], requirementIds: [], requirementNames: [], roomIds: [],
  roomNames: [], resourceIds: [], teacherNames: ["Anna Andersson"], hidden: false,
});
const suggestions = (proof: SuggestionChange["proof"], over: Partial<Suggestions> = {}): Suggestions => ({
  version: 1, state: "DONE", startedAt: "2027-03-05T10:00:00.000Z", finishedAt: "2027-03-05T10:01:30.000Z", verdict: "CHANGES",
  verified: proof !== "MAY_HELP", total: 5, searchSeconds: 60, verifySeconds: 2.5, changes: [change(proof), change(proof)], failure: null, report: null, ...over,
});
const render = (list: Suggestions) => {
  const job = { id: "job-1", status: "SUCCEEDED", solverStatus: "INFEASIBLE", conflicts: [], errorCode: null, errorParams: null, suggestionsOffered: true, suggestions: list } as unknown as OptimizationJob;
  return renderPlain(
    <QueryClientProvider client={new QueryClient()}>
      <SuggestionsCard job={job} />
    </QueryClientProvider>,
  );
};

type Node = { [key: string]: string | Node };
const say = (messages: unknown, locale: string, key: string, values: Record<string, unknown>): string =>
  String(new IntlMessageFormat(((messages as { generate: { suggestions: Node } }).generate.suggestions[key] as string), locale).format(values));

afterEach(cleanup);

describe("the line about the changes that are not shown", () => {
  it("says, under a list the engine did not check, that the list had more and that nothing in it is checked, and not that they belong to a solution", () => {
    render(suggestions("MAY_HELP"));
    expect(screen.getByText(`${NS}.moreMayHelp(3)`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.more(3)`)).toBeNull();
  });

  it("says, under a list the engine did check, that the rest belong to the same solution", () => {
    render(suggestions("SOLVED_TOGETHER"));
    expect(screen.getByText(`${NS}.more(3)`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.moreMayHelp(3)`)).toBeNull();
  });

  it("does not say in either language that the changes not shown are needed, which the proof does not show", () => {
    for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
      for (const count of [1, 7]) {
        expect(say(messages, locale, "more", { count }), `${locale} ${count}`).not.toMatch(/behövs|needed/i);
        expect(say(messages, locale, "moreMayHelp", { count }), `${locale} ${count}`).not.toMatch(/lösning|solution|behövs|needed/i);
      }
    }
    expect(say(sv, "sv", "more", { count: 7 })).toMatch(/Beviset gäller hela listan: de ändringar som visas är inte visade räcka utan dem/);
  });

  it("is grammatical in the English singular and plural", () => {
    expect(say(en, "en", "more", { count: 1 })).toMatch(/^1 more change belongs to the same solution and is not shown here\./);
    expect(say(en, "en", "more", { count: 7 })).toMatch(/^7 more changes belong to the same solution and are not shown here\./);
    expect(say(en, "en", "more", { count: 1 })).toMatch(/enough without the rest\.$/);
    expect(say(en, "en", "moreMayHelp", { count: 1 })).toMatch(/^The engine's list had 1 more change, which is not shown here\./);
    expect(say(en, "en", "moreMayHelp", { count: 7 })).toMatch(/^The engine's list had 7 more changes, which are not shown here\./);
  });

  it("is said the same way in the handbook", () => {
    const manual = readFileSync(resolve(process.cwd(), "../docs/manual/anvandarmanual.html"), "utf8").replace(/\s+/g, " ");
    expect(manual).not.toMatch(/det behövs alla för att veckan ska gå ihop/);
    expect(manual).toMatch(/Beviset gäller hela listan: de tre som visas är inte visade räcka utan de andra/);
  });
});
