import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import type { TimplanVerdict } from "@/lib/timplan-coverage";
import { WarningsRail } from "./warnings-rail";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join("|")})` : key,
}));

const VERDICTS: TimplanVerdict[] = [
  {
    code: "TIMPLAN_PROTECTED_SUBJECT_REDUCED",
    severity: "warning",
    subjectCode: "MA",
    stage: "LAG",
    subjectIds: ["s-ma"],
    params: { nationalHours: 420, plannedHours: 419.5, deficitHours: 0.6, reducedPercent: 0.2 },
  },
  {
    code: "TIMPLAN_STAGE_BELOW_NATIONAL",
    severity: "notice",
    subjectCode: "BL",
    stage: "LAG",
    subjectIds: ["s-bl"],
    params: { nationalHours: 60, plannedHours: 53.4, deficitHours: 6.6, reducedPercent: 11 },
  },
];

const names = new Map([
  ["MA", "Matematik"],
  ["BL", "Bild"],
]);

describe("WarningsRail", () => {
  it("formats each verdict from its figures, with the grid's decimal comma and the subject's name", () => {
    render(<WarningsRail verdicts={VERDICTS} nationalNames={names} live={false} selected={null} onSelect={() => {}} />);
    const first = screen.getByRole("button", { name: /PROTECTED_SUBJECT_REDUCED/ });
    expect(first).toHaveTextContent("plannedHours=419,5");
    expect(first).toHaveTextContent("deficitHours=0,6");
    expect(first).toHaveTextContent("subject=Matematik");
    expect(first).toHaveTextContent("stage=stagesInline.LAG");
    expect(first).toHaveTextContent("severity.warning");
    expect(screen.getByRole("button", { name: /STAGE_BELOW_NATIONAL/ })).toHaveTextContent("severity.notice");
  });

  it("selects a verdict on click and lets the same click clear it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <WarningsRail verdicts={VERDICTS} nationalNames={names} live={false} selected={null} onSelect={onSelect} />,
    );
    await user.click(screen.getByRole("button", { name: /STAGE_BELOW_NATIONAL/ }));
    expect(onSelect).toHaveBeenLastCalledWith(1);

    rerender(<WarningsRail verdicts={VERDICTS} nationalNames={names} live={false} selected={1} onSelect={onSelect} />);
    const pressed = screen.getByRole("button", { name: /STAGE_BELOW_NATIONAL/ });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    await user.click(pressed);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("says when the list is computed from unsaved edits, and when there is nothing under mål", () => {
    const { rerender } = render(
      <WarningsRail verdicts={VERDICTS} nationalNames={names} live selected={null} onSelect={() => {}} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("warningsLive");
    rerender(<WarningsRail verdicts={[]} nationalNames={names} live={false} selected={null} onSelect={() => {}} />);
    expect(screen.getByText("warningsEmpty")).toBeInTheDocument();
  });
});

describe("the Swedish copy says under mål, never fel", () => {
  it("has a sentence for every verdict code and none of them calls the plan wrong", () => {
    const timplan = (sv as unknown as { timplan: Record<string, unknown> }).timplan;
    const verdicts = timplan.verdicts as Record<string, string>;
    expect(Object.keys(verdicts).sort()).toEqual([
      "TIMPLAN_GROUP_MINIMUM_UNMET",
      "TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED",
      "TIMPLAN_PROTECTED_SUBJECT_REDUCED",
      "TIMPLAN_REDUCTION_OVER_CAP",
      "TIMPLAN_SKOLANS_VAL_OVERSPENT",
      "TIMPLAN_STAGE_BELOW_NATIONAL",
      "TIMPLAN_SUBJECT_UNMAPPED",
      "TIMPLAN_TOTAL_BELOW_GUARANTEE",
    ]);
    const everything = JSON.stringify(timplan);
    expect(everything).not.toMatch(/\bfel\b/i);
    expect(everything).not.toMatch(/\bfelaktig/i);
  });

  it("passes what the time counts as to the sentence, the pool when a check predates the parameter", () => {
    const below = (timeCountsAs?: string): TimplanVerdict => ({
      ...VERDICTS[1]!,
      params: { ...VERDICTS[1]!.params, ...(timeCountsAs ? { timeCountsAs } : {}) },
    });
    const { rerender } = render(
      <WarningsRail verdicts={[below("none")]} nationalNames={names} live={false} selected={null} onSelect={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /STAGE_BELOW_NATIONAL/ })).toHaveTextContent("timeCountsAs=none");
    rerender(<WarningsRail verdicts={[below()]} nationalNames={names} live={false} selected={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /STAGE_BELOW_NATIONAL/ })).toHaveTextContent("timeCountsAs=skolansVal");
  });

  it("claims skolans val in Swedish only for a bilaga that prints one", async () => {
    const { IntlMessageFormat } = await import("intl-messageformat");
    const say = (key: "TIMPLAN_STAGE_BELOW_NATIONAL" | "TIMPLAN_SUBJECT_UNMAPPED", timeCountsAs: string) =>
      String(
        new IntlMessageFormat(sv.timplan.verdicts[key], "sv").format({
          subject: "Kommunikation",
          stage: "lågstadiet",
          subjectName: "Sinnesträning",
          plannedHours: "30",
          deficitHours: "32",
          reducedPercent: "10,2",
          nationalHours: "315",
          timeCountsAs,
        }),
      );
    expect(say("TIMPLAN_STAGE_BELOW_NATIONAL", "skolansVal")).toMatch(/Tiden räknas mot skolans val\.$/);
    expect(say("TIMPLAN_STAGE_BELOW_NATIONAL", "none")).toBe("Kommunikation i lågstadiet: 32 h (10,2 %) under målet 315 h.");
    expect(say("TIMPLAN_SUBJECT_UNMAPPED", "skolansVal")).toContain("räknas som skolans val.");
    for (const value of ["fordelningsbar", "own"]) {
      expect(say("TIMPLAN_SUBJECT_UNMAPPED", value)).toContain("räknas som skolans egen tid.");
      expect(say("TIMPLAN_SUBJECT_UNMAPPED", value)).not.toContain("skolans val");
    }
    expect(say("TIMPLAN_SUBJECT_UNMAPPED", "fordelningsbar")).toContain("Fördelningsbar undervisningstid");
  });
});
