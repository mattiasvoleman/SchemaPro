import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormField } from "./form-field";
import { Input } from "./input";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => (key === "optional" ? "valfritt" : key),
}));

describe("FormField", () => {
  it("labels its control and leaves the aria props off when there is nothing to describe", () => {
    render(
      <FormField id="room-name" label="Namn">
        <Input />
      </FormField>,
    );

    const input = screen.getByRole("textbox", { name: "Namn" });
    expect(input).toHaveAttribute("id", "room-name");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input.parentElement).toHaveClass("space-y-1.5");
  });

  it("marks an optional field inside the label, in muted text", () => {
    render(
      <FormField id="room-building" label="Byggnad" optional>
        <Input />
      </FormField>,
    );
    expect(screen.getByRole("textbox", { name: "Byggnad (valfritt)" })).toBeInTheDocument();
    expect(screen.getByText("(valfritt)")).toHaveClass("text-muted-foreground");
  });

  it("links the hint, and the error with aria-invalid, keeping the control's own description", () => {
    render(
      <FormField id="weeks" label="Planeringsveckor" hint="Förslag: 35,6" error="Ange 20,0–40,0 veckor.">
        <Input aria-describedby="weeks-suggestion" />
      </FormField>,
    );

    const input = screen.getByRole("textbox", { name: "Planeringsveckor" });
    expect(input).toHaveAttribute("aria-describedby", "weeks-suggestion weeks-hint weeks-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Förslag: 35,6")).toHaveClass("text-xs", "text-muted-foreground");
    expect(screen.getByText("Ange 20,0–40,0 veckor.")).toHaveClass("text-xs", "text-destructive");
  });

  it("hands a function child the props, for a SelectTrigger", () => {
    render(
      <FormField id="room-type" label="Typ" hint="Salstypen styr vilka ämnen salen tar.">
        {(control) => (
          <button type="button" role="combobox" aria-expanded="false" {...control}>
            Klassrum
          </button>
        )}
      </FormField>,
    );

    const trigger = screen.getByRole("combobox", { name: "Typ" });
    expect(trigger).toHaveAttribute("id", "room-type");
    expect(trigger).toHaveAccessibleDescription("Salstypen styr vilka ämnen salen tar.");
  });

  it("lets an AAA page keep its hint in foreground", () => {
    render(
      <FormField id="credit" label="Minuter" hint="Räknas mot timplanen." hintClassName="text-foreground">
        <Input />
      </FormField>,
    );
    expect(screen.getByText("Räknas mot timplanen.")).toHaveClass("text-foreground");
  });
});
