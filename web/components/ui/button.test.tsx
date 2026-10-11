import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";

describe("Button", () => {
  it("fires onClick once per click", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies variant and size classes", () => {
    render(
      <Button variant="destructive" size="sm">
        Delete
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button).toHaveClass("bg-destructive", "h-8");
  });

  it("defaults to the primary variant and default size", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveClass("bg-primary", "h-9");
  });

  // `hover:bg-primary/90` faded the fill into the page and took the dark-mode
  // label to 4.34:1. The hover token is solid, 5.09 / 6.27 (globals-css.test.ts).
  it("hovers the primary variant to a solid shade, not a fade", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveClass("hover:bg-primary-hover");
    expect(button.className).not.toMatch(/hover:bg-primary\//);
  });

  it("lets a custom className win conflicting utilities via tailwind-merge", () => {
    render(<Button className="px-8">Wide</Button>);
    const button = screen.getByRole("button", { name: "Wide" });
    expect(button).toHaveClass("px-8");
    expect(button).not.toHaveClass("px-4");
  });

  it("renders the child element with button styling when asChild", () => {
    render(
      <Button asChild>
        <a href="/schedules">View schedules</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "View schedules" });
    expect(link).toHaveAttribute("href", "/schedules");
    expect(link).toHaveClass("bg-primary");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
