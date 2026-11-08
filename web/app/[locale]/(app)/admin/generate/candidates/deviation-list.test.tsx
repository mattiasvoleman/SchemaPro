import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { CandidateConflict } from "@/lib/candidates/types";
import { DeviationList } from "./deviation-list";

/*
 * The five DEVIATION_* sentences through the page's own path, with the real
 * catalogue and values of the shape the gateway hands the page (names where
 * the engine had anonymous ids): a sentence that names a value the gateway
 * does not send would fall back to the engine's English, and this is where
 * that shows. The masked sentence of a post's days is the web's own.
 */

const deviation = (code: string, params: Record<string, string | number>, resourceNames: string[] = []): CandidateConflict => ({
  category: "DEVIATION",
  code,
  params,
  message: `English for ${code}`,
  resourceNames,
});

const CAP = deviation(
  "DEVIATION_TEACHER_DAILY_CAP",
  { rule: "Arbetstid Anna", day: 2, minutes: 360, taught: 400, over: 40, needed: 400 },
  ["Anna Ek"],
);
const DAYS = deviation("DEVIATION_TEACHER_WORK_DAYS", { limit: "Tjänst Anna", days: 3, taught: 4, over: 1, needed: 4 }, ["Anna Ek"]);
const PER_DAY = deviation("DEVIATION_SUBJECT_PER_DAY", {
  requirement: "Matematik för 7A",
  day: 1,
  maxPerDay: 1,
  count: 2,
  over: 1,
  needed: 2,
});
const APART = deviation("DEVIATION_SUBJECT_DAYS_APART", {
  requirement: "Idrott för 8B",
  minDaysBetween: 2,
  pairs: 1,
  closest: 1,
  needed: 1,
});
const LOCK = deviation("DEVIATION_ROOM_LOCK", { requirement: "Matematik för 7A", lessons: 1, of: 3 });

function renderList(locale: "sv" | "en", deviations: CandidateConflict[]) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
      <h3 id="h">Avsteg</h3>
      <DeviationList deviations={deviations} aria-labelledby="h" />
    </NextIntlClientProvider>,
  );
}
const items = () => within(screen.getByRole("list", { name: "Avsteg" })).getAllByRole("listitem");

describe("DeviationList", () => {
  it("is a list named by its heading, one item to a rule that gave way", () => {
    renderList("sv", [CAP, DAYS, PER_DAY, APART, LOCK]);
    expect(items()).toHaveLength(5);
  });

  it("says the five sentences in Swedish from the values the gateway sends, and the names beside them", () => {
    renderList("sv", [CAP, DAYS, PER_DAY, APART, LOCK]);

    const text = items().map((item) => item.textContent ?? "");
    expect(text[0]).toContain("Taket på 360 minuters undervisning per dag som arbetstidsregeln Arbetstid Anna sätter gav vika på tisdagen");
    expect(text[0]).toContain("läraren undervisar 400 minuter, 40 över");
    expect(text[0]).toMatch(/Anna Ek$/);
    expect(text[1]).toContain("Tjänsten Tjänst Anna tillåter undervisning högst 3 dagar i veckan");
    expect(text[2]).toContain("Matematik för 7A har 2 lektioner på måndagen, mot en gräns på 1 per dag: 1 lektion för mycket");
    expect(text[3]).toContain("Idrott för 8B har lektioner 1 dag från varandra där regeln kräver minst 2");
    expect(text[4]).toContain("Matematik för 7A har 1 lektion av 3 i ett rum utanför de rum ämnet är låst till");
    // The engine's English is the fallback, and nothing fell back here.
    expect(text.join(" ")).not.toContain("English for");
  });

  it("says them in English too", () => {
    renderList("en", [CAP, PER_DAY, LOCK]);

    const text = items().map((item) => item.textContent ?? "");
    expect(text[0]).toContain("gave way on Tuesday");
    expect(text[1]).toContain("Matematik för 7A has 2 lessons on Monday, against a limit of 1 a day");
    expect(text[2]).toContain("has 1 lesson of 3 in a room outside the rooms the subject is locked to");
    expect(text.join(" ")).not.toContain("English for");
  });

  it("shows the engine's own English for a code this build has no sentence for", () => {
    renderList("sv", [deviation("DEVIATION_SOMETHING_NEW", { a: 1 })]);

    expect(items().map((item) => item.textContent)).toEqual(["English for DEVIATION_SOMETHING_NEW"]);
  });

  it.each([
    ["the hidden code of a post's days", deviation("TEACHER_WORK_DAYS_HIDDEN", {}, ["Anna Ek"])],
    ["the deviation's own code with its days taken out", deviation("DEVIATION_TEACHER_WORK_DAYS", { limit: "Tjänst Anna", over: 1 }, ["Anna Ek"])],
  ])("says a post's days as hidden, in a deviation's words and with no name, for %s", (_, masked) => {
    renderList("sv", [masked]);

    // Not the refusal's sentence, which says the timetable could not be made.
    expect(items()[0]!.textContent).toBe(
      "En lärares gräns för hur många dagar i veckan hen undervisar gav vika i det här schemat. Dagarna visas för rektor, en fullständig administratör och den som har HR-läs.",
    );
  });

  it("says the hidden days in English", () => {
    renderList("en", [deviation("TEACHER_WORK_DAYS_HIDDEN", {})]);
    expect(items()[0]!.textContent).toContain("gave way in this timetable");
  });
});
