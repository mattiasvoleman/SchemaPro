import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Notice } from "./notice";

// Key-echo translator: the dismiss button's default name is "close".
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("Notice", () => {
  it("is a neutral status by default, in foreground text on muted", () => {
    render(<Notice title="Inget mål satt">Sätt ett mål under Inställningar.</Notice>);

    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("bg-muted", "text-foreground", "rounded-md", "px-4", "py-3", "text-sm");
    expect(notice).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("Inget mål satt")).toHaveClass("font-medium");
    expect(screen.getByText("Sätt ett mål under Inställningar.")).toBeInTheDocument();
    expect(notice.querySelector("svg")).toBeNull();
  });

  it("draws a warning as a warning edge and icon on muted, still a status", () => {
    render(<Notice tone="warning">Lunchen är inte inställd.</Notice>);

    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("border", "border-warning/50", "bg-warning/10", "text-foreground");
    expect(notice).not.toHaveClass("border-l-4");
    // The icon uses the strong shade: plain --warning is 2.1:1 on white, under 3:1 for icons.
    expect(notice.querySelector("svg")).toHaveClass("text-warning-strong");
    expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("makes a destructive notice an alert whose text stays foreground", () => {
    render(<Notice tone="destructive" title="Läsåren kunde inte hämtas" />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveClass("border-destructive/40", "bg-destructive/5", "text-foreground");
    // The red is the edge and the icon; text-destructive on this tint is under AA.
    expect(notice).not.toHaveClass("text-destructive");
    expect(notice.querySelector("svg")).toHaveClass("text-destructive");
  });

  it("tints a success notice and hides the icon on request", () => {
    render(
      <Notice tone="success" hideIcon>
        Klart
      </Notice>,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("bg-success/10", "border", "border-success/40");
    expect(notice).not.toHaveClass("border-l-4");
    expect(notice.querySelector("svg")).toBeNull();
  });

  it("takes no live role inside a region that is already live", () => {
    render(
      <div role="status" data-testid="region">
        <Notice tone="destructive" role={null}>
          Sparades inte.
        </Notice>
      </div>,
    );

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders an action and a named dismiss button that calls back", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Notice title="Varning" action={<button type="button">Öppna</button>} onDismiss={onDismiss}>
        Text
      </Notice>,
    );

    expect(screen.getByRole("button", { name: "Öppna" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("names the dismiss button as told", () => {
    render(<Notice onDismiss={() => undefined} dismissLabel="Dölj varningen">Text</Notice>);
    expect(screen.getByRole("button", { name: "Dölj varningen" })).toBeInTheDocument();
  });
});
