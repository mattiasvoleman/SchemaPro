import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No schedules yet"
        description="Create your first schedule to get started."
      />,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "No schedules yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Create your first schedule to get started."),
    ).toBeInTheDocument();
  });

  it("omits the description paragraph when none is given", () => {
    render(<EmptyState icon={Inbox} title="No schedules yet" />);
    const heading = screen.getByRole("heading", { name: "No schedules yet" });
    // The description <p> is the heading's sibling when present; here nothing
    // should follow the heading.
    expect(heading.nextElementSibling).toBeNull();
  });

  it("renders a working action", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <EmptyState
        icon={Inbox}
        title="No schedules yet"
        action={<button onClick={onCreate}>Create schedule</button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("merges a custom className onto the root container", () => {
    render(<EmptyState icon={Inbox} title="Empty" className="py-8" />);
    // Root is a presentational div two levels above the heading; there is no
    // accessible handle for it.
    const root = screen.getByRole("heading", { name: "Empty" }).parentElement;
    expect(root).toHaveClass("py-8", "border-dashed");
    expect(root).not.toHaveClass("py-16");
  });

  it("draws the icon size-6 and hides it from assistive tech", () => {
    render(<EmptyState icon={Inbox} title="Empty" />);
    const icon = screen.getByRole("heading", { name: "Empty" }).parentElement?.querySelector("svg");
    expect(icon).toHaveClass("size-6", "text-muted-foreground");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("lets an AAA page put the description in foreground", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="Inga lov ännu"
        description="Lägg in skolans lov."
        descriptionClassName="text-foreground"
      />,
    );
    const description = screen.getByText("Lägg in skolans lov.");
    expect(description).toHaveClass("text-foreground", "text-sm");
    expect(description).not.toHaveClass("text-muted-foreground");
  });

  it("takes an h2 when it stands directly under the page's h1", () => {
    render(<EmptyState icon={Inbox} title="Inget läsår ännu" headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Inget läsår ännu" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });
});
