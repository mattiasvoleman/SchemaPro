import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadError } from "./load-error";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("LoadError", () => {
  it("fills the page's place with the title and the hint, announced as an alert", () => {
    render(<LoadError title="Timplanen kunde inte hämtas" hint="Inget av det som visas här har ändrats." />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Timplanen kunde inte hämtas");
    expect(screen.getByRole("heading", { level: 3, name: "Timplanen kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.getByText("Inget av det som visas här har ändrats.")).toHaveClass("text-muted-foreground");
    // The EmptyState frame, with the warning triangle.
    expect(alert.querySelector(".border-dashed svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("takes an h2 under the page's h1 and the AAA hint colour", () => {
    render(
      <LoadError
        title="Loven kunde inte hämtas"
        hint="Inget har ändrats."
        headingLevel={2}
        hintClassName="text-foreground"
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Loven kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.getByText("Inget har ändrats.")).toHaveClass("text-foreground");
    expect(screen.getByText("Inget har ändrats.")).not.toHaveClass("text-muted-foreground");
  });

  it("is a destructive notice inside a section", () => {
    render(
      <LoadError
        variant="inline"
        title="Frånvaron kunde inte hämtas"
        hint="Dina vikariepass ovan påverkas inte."
        action={<button type="button">Försök igen</button>}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-tone", "destructive");
    expect(alert).toHaveTextContent("Frånvaron kunde inte hämtas");
    expect(alert).toHaveTextContent("Dina vikariepass ovan påverkas inte.");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeInTheDocument();
  });
});
