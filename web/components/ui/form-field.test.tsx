import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormField, FormProblems } from "./form-field";
import { Input } from "./input";

const SAYS: Record<string, string> = { optional: "valfritt", validationEmpty: "får inte vara tomt", validationMax: "får inte vara större än {max}" };
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    (SAYS[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? ""),
}));

/** A failed save as api.ts builds it, as a shape. */
const refused = (...problems: string[]) => Object.assign(new Error("One or more fields failed validation."), { status: 400, problems });

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

  describe("inside a FormProblems", () => {
    it("draws the sentence the gateway's validation gave for its property, as the error, beside its control", () => {
      render(
        <FormProblems error={refused("name should not be empty", "capacity must not be greater than 10000")}>
          <FormField id="room-name" label="Namn" field="name">
            <Input />
          </FormField>
          <FormField id="room-capacity" label="Platser" field="capacity">
            <Input />
          </FormField>
          <FormField id="room-code" label="Kod" field="code">
            <Input />
          </FormField>
        </FormProblems>,
      );
      const name = screen.getByRole("textbox", { name: "Namn" });
      expect(name).toHaveAttribute("aria-invalid", "true");
      expect(name).toHaveAttribute("aria-describedby", "room-name-error");
      expect(screen.getByText("Får inte vara tomt.")).toHaveClass("text-destructive");
      expect(screen.getByRole("textbox", { name: "Platser" })).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("Får inte vara större än 10000.")).toBeInTheDocument();
      // A property no sentence names is left as it was.
      expect(screen.getByRole("textbox", { name: "Kod" })).not.toHaveAttribute("aria-invalid");
    });

    it("leaves a control with no `field`, and a form with no failure, as they were, and lets an explicit error win", () => {
      const { rerender } = render(
        <FormProblems error={refused("name should not be empty")}>
          <FormField id="room-name" label="Namn">
            <Input />
          </FormField>
          <FormField id="room-name-2" label="Andra namnet" field="name" error="Namnet är taget.">
            <Input />
          </FormField>
        </FormProblems>,
      );
      expect(screen.getByRole("textbox", { name: "Namn" })).not.toHaveAttribute("aria-invalid");
      expect(screen.getByText("Namnet är taget.")).toBeInTheDocument();
      expect(screen.queryByText("Får inte vara tomt.")).not.toBeInTheDocument();
      rerender(
        <FormProblems error={null}>
          <FormField id="room-name" label="Namn" field="name">
            <Input />
          </FormField>
        </FormProblems>,
      );
      expect(screen.getByRole("textbox", { name: "Namn" })).not.toHaveAttribute("aria-invalid");
    });

    it("reads nothing outside a FormProblems", () => {
      render(
        <FormField id="room-name" label="Namn" field="name">
          <Input />
        </FormField>,
      );
      expect(screen.getByRole("textbox", { name: "Namn" })).not.toHaveAttribute("aria-invalid");
    });
  });
});
