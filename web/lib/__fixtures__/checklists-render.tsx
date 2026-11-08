import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { vi, type Mock } from "vitest";
import { ApiError } from "@/lib/api";
import type {
  ConsentDetail,
  ConsentListItem,
  GroupChoice,
  Instructor,
  ProofRoster,
  PupilCard,
  TemplateView,
} from "@/lib/checklists";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { GROUPS, INSTRUCTORS, TEMPLATES, card, detail, listItem, roster } from "./checklists";

/*
 * What Checklistor's tests share: the real messages (a key missing from sv.json
 * throws), a query client that does not retry, and a stand-in for the
 * gateway's GET routes that answers from one `Scenario` a test changes.
 */

// Checklistor's screens open dialogs that are fetched on the first click, and tables of a class: a loaded machine needs more than the defaults.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

/**
 * The parts of the page that are fetched when they are first drawn or clicked (the dialogs, the printed sheet, the
 * consent tab, the templates): loaded once, before the tests, so that no test pays for a module's first transform.
 */
export const warmChecklists = () =>
  Promise.all([
    import("@/components/checklists/dialogs"),
    import("@/components/checklists/consent-tab"),
    import("@/components/checklists/templates-card"),
    import("@/components/checklists/printed-sheet"),
    import("@/components/checklists/print-actions"),
  ]);

export const BASE = "/api/v1/checklists";

export interface Scenario {
  templates: TemplateView[];
  groups: GroupChoice[];
  instructors: Instructor[];
  roster: ProofRoster;
  card: PupilCard;
  lists: ConsentListItem[];
  detail: ConsentDetail;
  /** The pupils the school has marked as having a protected identity: the gateway leaves them out of what it answers for paper. */
  marks: string[];
  /** A route name that answers with this error: "templates", "groups", "instructors", "roster", "card", "lists", "detail", "paper". */
  fails: Partial<Record<string, Error>>;
}

export function scenario(): Scenario {
  return {
    templates: TEMPLATES,
    groups: GROUPS,
    instructors: INSTRUCTORS,
    roster: roster(),
    card: card(),
    lists: [listItem(), listItem({ id: "l-2", title: "Utflykt till Skansen", counts: { pupils: 3, granted: 3, declined: 0, withdrawn: 0, asked: 0, missing: 0 }, createdByName: null })],
    detail: detail(),
    marks: [],
    fails: {},
  };
}

/** Makes `api.get` answer the gateway's routes from the scenario; an unknown route throws, so a test learns of a read it did not expect. */
export function installApi(api: { get: Mock }, state: Scenario): void {
  api.get.mockImplementation(async (path: string) => {
    const route = (name: string) => {
      const failure = state.fails[name];
      if (failure) throw failure;
    };
    const url = new URL(path, "http://gateway");
    const tail = url.pathname.slice(BASE.length);
    if (tail === "/templates") {
      route("templates");
      return url.searchParams.get("includeRetired") === "true" ? state.templates : state.templates.filter((one) => one.active);
    }
    if (tail === "/groups") {
      route("groups");
      return state.groups;
    }
    if (tail === "/instructors") {
      route("instructors");
      return state.instructors;
    }
    // For paper the gateway leaves the marked pupils out of the rows and the counts, and counts them in heldOut.
    if (/^\/templates\/[^/]+\/roster\/print$/.test(tail)) {
      route("paper");
      const rows = state.roster.rows.filter((one) => !state.marks.includes(one.studentId));
      return {
        ...state.roster,
        rows,
        done: rows.filter((one) => one.proofs.length > 0).length,
        pupils: rows.length,
        heldOut: state.roster.rows.length - rows.length,
      };
    }
    if (/^\/consent-lists\/[^/]+\/print$/.test(tail)) {
      route("paper");
      const rows = state.detail.rows.filter((one) => !state.marks.includes(one.studentId));
      const count = (...states: string[]) => rows.filter((one) => states.includes(one.state)).length;
      return {
        ...state.detail,
        rows,
        list: {
          ...state.detail.list,
          counts: { pupils: rows.length, granted: count("GRANTED"), declined: count("DECLINED"), withdrawn: count("WITHDRAWN"), asked: count("ASKED"), missing: count("MISSING") },
        },
        heldOut: state.detail.rows.length - rows.length,
      };
    }
    if (/^\/templates\/[^/]+\/roster$/.test(tail)) {
      route("roster");
      return state.roster;
    }
    if (tail.startsWith("/students/")) {
      route("card");
      return state.card;
    }
    if (tail === "/consent-lists") {
      route("lists");
      return state.lists;
    }
    if (tail.startsWith("/consent-lists/")) {
      route("detail");
      return state.detail;
    }
    throw new Error(`unexpected read ${path}`);
  });
}

export function apiError(status: number, code?: string, message = "boom"): ApiError {
  return new ApiError(status, message, code);
}

export function renderChecklists(ui: ReactElement, locale: "sv" | "en" = "sv") {
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
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** The paths read so far, in order. */
export const reads = (api: { get: Mock }): string[] => api.get.mock.calls.map(([path]) => path as string);

/** A subjects stand-in for the PostgREST client: `from("Subjects").select().order().order()` resolves with `rows`. */
export function subjectsClient(rows: Array<{ id: string; name: string }>) {
  const result = { data: rows, error: null };
  const order = { order: () => Promise.resolve(result) };
  return { from: vi.fn(() => ({ select: vi.fn(() => ({ order: vi.fn(() => order) })) })) };
}
