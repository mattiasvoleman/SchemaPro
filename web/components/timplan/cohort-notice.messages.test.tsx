import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { cohortNotice } from "@/lib/timplan-cohorts";
import sv from "@/messages/sv.json";
import { CohortNotice } from "./cohort-notice";

/*
 * "Timplaner per årskull" with the real Swedish messages. The cohort notice
 * always adds the first reformed cohort (HT 2028). For a school form whose
 * 2028 version the reference data does not hold — specialskolan, whose
 * 8 604 h is deliberately unseeded — the missing version is the NEWER one,
 * and specialskolan has eleven grades, sameskolan seven: never "tioårig
 * grundskola", never "äldre lydelse".
 */

const versions = [
  { code: "SFS2023:945/B3", schoolForm: "SPECIALSKOLA" as const, appliesFromCohortTerm: "HT2024", appliesBy: "STAGES_NOT_COMPLETED" as const, entryCount: 10 },
  { code: "SFS2025:729", schoolForm: "GRUNDSKOLA" as const, appliesFromCohortTerm: "HT2028", appliesBy: "COHORTS_STARTING" as const, entryCount: 0 },
];

function show(schoolForm: "SPECIALSKOLA" | "GRUNDSKOLA") {
  const rows = cohortNotice([{ id: "c7a", name: "7A", gradeLevel: 7, ht: 2026 }], versions, schoolForm);
  render(
    <NextIntlClientProvider locale="sv" messages={sv}>
      <CohortNotice rows={rows} />
    </NextIntlClientProvider>,
  );
}

describe("CohortNotice, in Swedish", () => {
  it("calls a missing 2028 version the 2028 one, and names no ten-year school for specialskolan", () => {
    show("SPECIALSKOLA");
    const reformed = screen.getByText(/HT 2028/).closest("li")!;
    expect(reformed).not.toHaveTextContent("tioårig grundskola");
    expect(reformed).not.toHaveTextContent("äldre lydelse");
    expect(reformed).toHaveTextContent("lydelsen från hösten 2028 finns inte i referensdatan");
    // The old cohort's own rows still read bilaga 3.
    expect(screen.getByText(/HT 2020/).closest("li")!).toHaveTextContent("SFS 2023:945 B3");
  });
});
