import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookOpen } from "lucide-react";
import { Stepper } from "./stepper";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => (key === "stepDone" ? "klart" : key),
}));

const steps = [
  { id: "year", label: "Läsår", done: true },
  { id: "subjects", label: "Ämnen", done: true, icon: BookOpen, meta: 12 },
  { id: "rooms", label: "Salar" },
];

describe("Stepper", () => {
  it("is a named ordered list with the current step marked", () => {
    render(<Stepper steps={steps} current="subjects" label="Steg i Kom igång" />);

    const list = screen.getByRole("list", { name: "Steg i Kom igång" });
    expect(list.tagName).toBe("OL");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const current = screen.getByText("Ämnen").closest("[aria-current]");
    expect(current).toHaveAttribute("aria-current", "step");
    expect(current).toHaveClass("bg-primary", "text-primary-foreground", "rounded-full");
    expect(current).toHaveTextContent("12");
  });

  it("tints a done step with a Check and says it is done, text kept in foreground", () => {
    render(<Stepper steps={steps} current="rooms" label="Steg" />);

    // getByText matches on an element's own text nodes: the pill itself.
    const done = screen.getByText("Läsår");
    expect(done).toHaveClass("bg-success/10", "text-foreground");
    expect(done).not.toHaveClass("text-success-strong");
    expect(done).toHaveTextContent("Läsår, klart");
    // The icon uses the strong shade: plain --success is 3.3:1 on light grounds.
    expect(done.querySelector("svg")).toHaveClass("text-success-strong");
    expect(done).not.toHaveAttribute("aria-current");
  });

  it("numbers a step without an icon, and separates steps with a hidden arrow", () => {
    const { container } = render(<Stepper steps={steps} current="year" label="Steg" />);
    expect(screen.getByText("Salar")).toHaveTextContent("3Salar");
    const arrows = container.querySelectorAll("li > svg");
    expect(arrows).toHaveLength(2);
    arrows.forEach((arrow) => expect(arrow).toHaveAttribute("aria-hidden", "true"));
  });

  it("is text without onSelect and buttons with it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Stepper steps={steps} current="year" label="Steg" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    const onSelect = vi.fn();
    rerender(<Stepper steps={steps} current="year" label="Steg" onSelect={onSelect} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: /Salar/ }));
    expect(onSelect).toHaveBeenCalledWith("rooms");
    expect(screen.getByRole("button", { name: /Läsår/ })).toHaveAttribute("aria-current", "step");
  });
});
