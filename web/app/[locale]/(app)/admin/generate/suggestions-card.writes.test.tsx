import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render as renderPlain, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOnlyStyle } from "@/components/admin/area-refusal";
import { ADMIN_PROFILES, profileWrites, type AdminArea } from "@/lib/admin-areas";
import type { OptimizationJob } from "@/lib/queries";
import { SuggestionsCard } from "./suggestions-card";

/*
 * THE OFFER'S BUTTON IS HIDDEN FROM EXACTLY THE PROFILES THE GATEWAY WOULD REFUSE (the review of #388, g388-L-5b).
 *
 * `data-writes` is read in one place: readOnlyStyle (components/admin/area-refusal.tsx), which the (app) layout writes as a style rule. A control marked
 * data-writes="A B" is hidden from a profile that does not write A, and from one that does not write B. The gateway's route for the analysis
 * (POST /optimization/jobs/:id/suggestions, src/optimization/suggestions.controller.ts) asks for @Area('SCHEMALAGGNING', 'DRIFT'): an administrator must
 * write EVERY one of them. The button carried SCHEMALAGGNING alone, so a profile that writes Schemaläggning and not Drift would have been offered a button
 * the gateway answers 403. No profile of today's matrix is that one, which is why nothing was seen; the mark is the page's half of the promise that it offers no
 * button the gateway would refuse.
 *
 * Two proofs, and each falls on the old mark: that the mark names the areas the controller names, read from the controller's source (the web cannot import it);
 * and that the rule the layout writes shows the button to exactly the profiles that write all of them, for every profile the matrix has.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("style[data-test-writes]").forEach((style) => style.remove());
});

const REFUSED_RUN = {
  id: "job-1",
  status: "SUCCEEDED",
  solverStatus: "INFEASIBLE",
  createdAt: "2027-03-05T09:00:00.000Z",
  finishedAt: "2027-03-05T09:03:00.000Z",
  suggestionsOffered: true,
  suggestions: null,
} as unknown as OptimizationJob;

function offerButton(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderPlain(
    <QueryClientProvider client={client}>
      <SuggestionsCard job={REFUSED_RUN} />
    </QueryClientProvider>,
  );
  return screen.getByRole("button", { name: "generate.suggestions.offerAction" });
}

/**
 * The areas the gateway asks of the route that starts the analysis: the class's @Area, read from the controller's source. RolesGuard reads the
 * handler's @Area before the class's (getAllAndOverride), and a route of the neighbouring controller does carry its own (POST candidates), so a
 * second @Area in this file would ask something else of the route than the class says. The file holds one, and a second is refused here
 * rather than read around: whoever adds it also says here which of the two the button follows.
 */
function gatewayAreas(): AdminArea[] {
  const source = readFileSync(path.resolve(__dirname, "../../../../../../src/optimization/suggestions.controller.ts"), "utf8");
  expect(
    [...source.matchAll(/^\s*@Area\(/gm)],
    "the controller has an @Area besides the class's: the handler's wins in RolesGuard, and this test reads only the class's",
  ).toHaveLength(1);
  const decorated = /@Area\(([^)]*)\)\s*export class SuggestionsController\b/.exec(source);
  expect(decorated, "the controller's class carries an @Area(...)").not.toBeNull();
  const areas = [...decorated![1]!.matchAll(/'([A-Z]+)'/g)].map((found) => found[1] as AdminArea);
  expect(areas.length, "@Area names at least one area").toBeGreaterThan(0);
  return areas;
}

describe("the button that offers the analysis", () => {
  it("is marked with every area the gateway asks of the route it calls: Schemaläggning and Drift", () => {
    const mark = (offerButton().getAttribute("data-writes") ?? "").split(/\s+/).filter((token) => token !== "");
    expect([...mark].sort()).toEqual([...gatewayAreas()].sort());
  });

  it.each(ADMIN_PROFILES.map((profile) => [profile] as const))(
    "is shown to the %s profile when it writes every area the gateway asks, and hidden from it when it does not (the rule the layout writes)",
    (profile) => {
      const button = offerButton();
      const style = document.createElement("style");
      style.setAttribute("data-test-writes", "");
      style.textContent = readOnlyStyle([], profile, "Meny");
      document.head.appendChild(style);
      const accepted = gatewayAreas().every((area) => profileWrites(profile, area));
      expect(window.getComputedStyle(button).display === "none", `the ${profile} profile`).toBe(!accepted);
    },
  );
});
