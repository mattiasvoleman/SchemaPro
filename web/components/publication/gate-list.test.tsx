import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  GATE_CODES,
  GATE_OF_POLICY,
  GATE_POLICY_KEYS,
  type GateCode,
  type GateItem,
} from "@/lib/publication-types";
import { GateList } from "./gate-list";

/**
 * The named checks before a publish, in both languages. The finding
 * PUB_DEVIATIONS (Bästa möjliga schema: rules that gave way in the latest
 * applied timetable) is a code of the gateway's and a column of the school's
 * policy; the web names it in three places that have to agree, and in two
 * languages.
 */

type Messages = Record<string, unknown>;
const publishing = (messages: unknown) => (messages as { publishing: { gates: Messages; policy: Messages } }).publishing;

const gate = (code: GateCode, severity: GateItem["severity"], count: number, labels: string[] = []): GateItem => ({
  code,
  severity,
  count,
  items: labels.map((label) => ({ label })),
  params: {},
});

function renderGates(locale: "sv" | "en", gates: GateItem[]) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
      <GateList gates={gates} />
    </NextIntlClientProvider>,
  );
}

describe("the check PUB_DEVIATIONS", () => {
  it("is a code the web knows, with the policy column the gateway names for it", () => {
    expect(GATE_CODES).toContain("PUB_DEVIATIONS");
    expect(GATE_POLICY_KEYS).toContain("gateDeviations");
    expect(GATE_OF_POLICY.gateDeviations).toBe("PUB_DEVIATIONS");
  });

  it("is said in Swedish as a warning, counted, with the avsteg listed", () => {
    renderGates("sv", [gate("PUB_DEVIATIONS", "WARN", 2, ["Taket på 360 minuter gav vika", "Rumslåset gav vika"])]);

    const text = screen.getByRole("list", { name: "Kontroller" }).textContent ?? "";
    expect(text).toContain("Varnar:");
    expect(text).toContain("2 regler gav vika i det senast tillämpade schemaförslaget (Bästa möjliga schema)");
    const inner = within(screen.getByRole("list", { name: "Kontroller" })).getAllByRole("list")[0]!;
    expect(within(inner).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Taket på 360 minuter gav vika",
      "Rumslåset gav vika",
    ]);
  });

  it("is said in English, in the singular for one", () => {
    renderGates("en", [gate("PUB_DEVIATIONS", "WARN", 1)]);

    const text = screen.getByRole("list", { name: "Checks" }).textContent ?? "";
    expect(text).toContain("1 rule gave way in the latest applied timetable proposal (Best possible timetable)");
    expect(text).toContain("publish anyway");
  });

  it("stops the publish in words when the school chose to refuse on it", () => {
    renderGates("sv", [gate("PUB_DEVIATIONS", "REFUSE", 1)]);
    expect(screen.getByRole("list", { name: "Kontroller" }).textContent).toContain("Stoppar:");
  });
});

describe.each([
  ["sv", sv],
  ["en", en],
])("the checks in %s", (_, messages) => {
  it("have a sentence for every code the gateway can name", () => {
    const gates = publishing(messages).gates;
    expect(GATE_CODES.filter((code) => typeof gates[code] !== "string")).toEqual([]);
  });

  it("have a heading in the policy for every code a school can set", () => {
    const policy = publishing(messages).policy;
    const settable = GATE_POLICY_KEYS.map((key) => GATE_OF_POLICY[key]);
    expect(settable.filter((code) => typeof policy[code] !== "string")).toEqual([]);
  });
});
