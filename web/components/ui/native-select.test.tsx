import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(select.className).toContain("focus-visible:ring-1");
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

  it("keeps the class the integrations page already used", () => {
    expect(NATIVE_SELECT_CLASS.startsWith("flex h-9 w-full rounded-md border border-input")).toBe(true);
  });
});
