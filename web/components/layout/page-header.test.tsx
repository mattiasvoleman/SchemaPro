import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { PageHeader } from "./page-header";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  document.title = "";
});

describe("PageHeader", () => {
  it("renders the h1 and subtitle with their unchanged classes", () => {
    render(<PageHeader title="Timplan" subtitle="Skolans lokala timplan" />);

    const heading = screen.getByRole("heading", { level: 1, name: "Timplan" });
    expect(heading).toHaveClass("text-2xl", "font-semibold", "tracking-tight");
    expect(screen.getByText("Skolans lokala timplan")).toHaveClass("mt-1", "text-sm", "text-muted-foreground");
    // The wrapper keeps its margin and its row layout from sm up.
    expect(heading.parentElement?.parentElement).toHaveClass("mb-6", "sm:flex-row", "sm:justify-between");
  });

  it("names the browser tab after the h1", () => {
    render(<PageHeader title="Tjänstefördelning" />);
    expect(document.title).toBe("Tjänstefördelning · Rastra Schema");
  });

  it("renders a named back link above the h1, hidden in print", () => {
    render(<PageHeader title="Uppdragsbeskrivning" back={{ href: "/admin/staffing", label: "Till tjänstefördelningen" }} />);

    const back = screen.getByRole("link", { name: "Till tjänstefördelningen" });
    expect(back).toHaveAttribute("href", "/admin/staffing");
    expect(back).toHaveClass("print:hidden");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders meta and intro under the title, the intro in foreground at a readable measure", () => {
    render(
      <PageHeader
        title="Publicering"
        meta={<span>Utkast</span>}
        intro={<p>Ett publicerat schema gäller från sitt datum.</p>}
      />,
    );

    expect(screen.getByText("Utkast").parentElement).toHaveClass("flex", "flex-wrap", "gap-2");
    expect(screen.getByText("Ett publicerat schema gäller från sitt datum.").parentElement).toHaveClass(
      "max-w-prose",
      "text-sm",
      "text-foreground",
    );
  });

  it("centres the actions beside a title and subtitle", () => {
    render(
      <PageHeader title="Timplan" subtitle="Skolans lokala timplan" actions={<button type="button">Spara</button>} />,
    );
    const wrapper = screen.getByRole("heading", { level: 1 }).parentElement?.parentElement;
    expect(wrapper).toHaveClass("sm:items-center");
    expect(wrapper).not.toHaveClass("sm:items-start");
  });

  it("holds the actions at the top beside the title when an intro or a badge row makes the block tall", () => {
    const { rerender } = render(
      <PageHeader title="Publicering" intro="Ett publicerat schema gäller från sitt datum." actions={<button type="button">Publicera</button>} />,
    );
    const wrapper = () => screen.getByRole("heading", { level: 1 }).parentElement?.parentElement;
    expect(wrapper()).toHaveClass("sm:items-start");
    expect(wrapper()).not.toHaveClass("sm:items-center");

    rerender(<PageHeader title="Timplan" meta={<span>Utkast</span>} actions={<button type="button">Spara</button>} />);
    expect(wrapper()).toHaveClass("sm:items-start");

    // A slot given as null (a badge that has nothing to count yet) is no slot.
    rerender(<PageHeader title="Timplan" meta={null} actions={<button type="button">Spara</button>} />);
    expect(wrapper()).toHaveClass("sm:items-center");
  });

  it("wraps the actions instead of pushing them off-screen", () => {
    render(<PageHeader title="Grundschema" actions={<button type="button">Publicera</button>} />);
    const actions = screen.getByRole("button", { name: "Publicera" }).parentElement;
    expect(actions).toHaveClass("flex", "flex-wrap", "items-center", "gap-2");
    expect(actions).not.toHaveClass("shrink-0");
  });

  it("renders none of the optional slots when they are not given", () => {
    const { container } = render(<PageHeader title="Översikt" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});
