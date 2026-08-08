import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Label } from "./label";
import { Input } from "./input";

describe("Label", () => {
  it("associates with a control via htmlFor so the control is queryable by label", () => {
    render(
      <div>
        <Label htmlFor="school-name">School name</Label>
        <Input id="school-name" />
      </div>,
    );

    const input = screen.getByLabelText("School name");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input).toHaveAttribute("id", "school-name");
  });

  it("merges custom classes with the defaults", () => {
    render(<Label className="text-destructive">Required field</Label>);
    const label = screen.getByText("Required field");
    expect(label).toHaveClass("text-destructive");
    expect(label).toHaveClass("font-medium");
  });
});
