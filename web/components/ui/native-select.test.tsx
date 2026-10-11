import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Input } from "./input";
import { NATIVE_SELECT_CLASS, NativeSelect } from "./native-select";

describe("NativeSelect", () => {
  it("is a labelled native select with the input look", () => {
    render(
      <>
        <label htmlFor="child">Barn</label>
        <NativeSelect id="child" defaultValue="b">
          <option value="a">Alva</option>
          <option value="b">Bo</option>
        </NativeSelect>
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Barn" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveValue("b");
    expect(select.className).toContain("rounded-md");
  });

  // It used to draw a 1px ring where Input draws 2px, so focus looked weaker
  // on the guardian's page than on every other form.
  it("draws the same edge and focus ring as Input", () => {
    render(
      <>
        <Input aria-label="Namn" />
        <NativeSelect aria-label="Barn">
          <option value="a">Alva</option>
        </NativeSelect>
      </>,
    );
    const edgeAndRing = (element: HTMLElement) =>
      element.className
        .split(/\s+/)
        .filter((name) => /^(border|focus-visible:ring)(-|$)/.test(name))
        .sort();
    const input = edgeAndRing(screen.getByRole("textbox", { name: "Namn" }));
    expect(input).toEqual(["border", "border-input-strong", "focus-visible:ring-2", "focus-visible:ring-ring"]);
    expect(edgeAndRing(screen.getByRole("combobox", { name: "Barn" }))).toEqual(input);
  });

  it("passes changes and extra classes through", () => {
    const onChange = vi.fn();
    render(
      <NativeSelect aria-label="Typ" className="w-40" onChange={onChange} defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </NativeSelect>,
    );
    const select = screen.getByRole("combobox", { name: "Typ" });
    expect(select.className).toContain("w-40");
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the input box the integrations page already used", () => {
    expect(NATIVE_SELECT_CLASS.startsWith("flex h-9 w-full rounded-md border border-input-strong")).toBe(true);
  });
});
