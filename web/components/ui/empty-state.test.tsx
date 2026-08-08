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
});
