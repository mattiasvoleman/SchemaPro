import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { flattenLabels, type Labels } from "@/lib/pseudonym-labels";
import svMessages from "@/messages/sv.json";
import { PseudonymiserareTool } from "./tool";

/*
 * The result's landmarks (the review of #398). axe's best-practice rule landmark-unique found two regions called "Det som byttes ut" in every result, in both
 * languages and both themes: the section of the counts and the scrollable table inside it. A screen reader's list of landmarks then holds the same name twice.
 */

const sv = flattenLabels(svMessages.pseudonymiserare) as Labels;

afterEach(cleanup);

describe("the result", () => {
  it("has no two regions with the same name", async () => {
    const user = userEvent.setup();
    render(<PseudonymiserareTool labels={sv} locale="sv" />);
    const file = new File(["Lärare;Klass;Notis\r\nAnna Svensson;7A;Ring 070-123 45 67\r\nBo Ek;7B;Prov\r\n"], "lektioner.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText(sv["tool.chooseFiles"]), file);
    await user.selectOptions(await screen.findByLabelText(sv["col.choiceLabel"].replace("{n}", "3")), "keep");
    await user.click(screen.getByRole("button", { name: sv["tool.run"] }));
    await screen.findByRole("heading", { name: sv["result.countsHeading"] });
    const names = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label") ?? document.getElementById(region.getAttribute("aria-labelledby") ?? "")?.textContent ?? "");
    expect(names.filter((name) => name === sv["result.countsHeading"])).toHaveLength(1);
    expect(new Set(names).size, names.join(" | ")).toBe(names.length);
  });
});
