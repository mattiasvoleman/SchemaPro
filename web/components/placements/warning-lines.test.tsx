import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WarningLines } from "./warning-lines";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => Object.assign((key: string) => key, { has: () => true }),
}));

const REFUSES = { key: "a", text: "Klassen får ingen lunch.", refuses: true };
const STANDS = { key: "b", text: "Läraren undervisar länge.", refuses: false };

describe("the lines of what the week says of a lesson", () => {
  it("draws nothing for a lesson with no warning", () => {
    const { container } = render(<WarningLines items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a list named for what it is, a line per warning, each with the word and not the colour alone", () => {
    render(<WarningLines items={[REFUSES, STANDS]} />);
    const list = screen.getByRole("list", { name: "title" });
    const lines = within(list).getAllByTestId("placement-warning");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveTextContent("label");
    // The icon is a picture of the word beside it: hidden from the reader who hears the word.
    expect(list.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(2);
  });

  it("says after a warning that refuses what that means, in the list as in the dialog", () => {
    const { rerender } = render(<WarningLines items={[REFUSES]} />);
    expect(screen.getByTestId("placement-warning")).toHaveTextContent("Klassen får ingen lunch. refuses");
    rerender(<WarningLines items={[REFUSES]} dialog />);
    expect(screen.getByTestId("placement-warning")).toHaveTextContent("Klassen får ingen lunch. refuses");
  });

  it("says that the lesson is saved and that the warning does not stop Generera after a warning that does not refuse, in the dialog only", () => {
    const { rerender } = render(<WarningLines items={[STANDS]} />);
    expect(screen.getByTestId("placement-warning")).toHaveTextContent(/^label Läraren undervisar länge\.$/);
    rerender(<WarningLines items={[STANDS]} dialog />);
    expect(screen.getByTestId("placement-warning")).toHaveTextContent("Läraren undervisar länge. standsAnyway");
    expect(screen.getByTestId("placement-warning")).not.toHaveTextContent("refuses");
  });
});
