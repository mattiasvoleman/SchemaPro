import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Users } from "lucide-react";
import { SectionCard } from "./section-card";

describe("SectionCard", () => {
  it("is a region named by its own h2", () => {
    render(
      <SectionCard id="registered" title="Registrerad frånvaro">
        <p>body</p>
      </SectionCard>,
    );

    const region = screen.getByRole("region", { name: "Registrerad frånvaro" });
    expect(region).toHaveAttribute("id", "registered");
    expect(region).toHaveClass("space-y-3", "rounded-lg", "border", "bg-card", "p-4");
    const heading = screen.getByRole("heading", { level: 2, name: "Registrerad frånvaro" });
    expect(heading).toHaveAttribute("id", "registered-title");
    expect(heading).toHaveClass("text-base", "font-semibold");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("takes an h3 in text-sm when nested", () => {
    render(<SectionCard id="day-1" title="Måndag" headingLevel={3} />);
    const heading = screen.getByRole("heading", { level: 3, name: "Måndag" });
    expect(heading).toHaveClass("text-sm", "font-semibold");
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("draws a decorative size-4 icon before the title, outside its name", () => {
    render(<SectionCard id="people" title="Personer" icon={Users} />);
    const heading = screen.getByRole("heading", { name: "Personer" });
    const icon = heading.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("size-4", "text-muted-foreground");
  });

  it("renders the description muted, or in the colour an AAA page asks for", () => {
    const { rerender } = render(<SectionCard id="a" title="A" description="Två meningar." />);
    expect(screen.getByText("Två meningar.")).toHaveClass("text-sm", "text-muted-foreground");

    rerender(<SectionCard id="a" title="A" description="Två meningar." descriptionClassName="text-foreground" />);
    expect(screen.getByText("Två meningar.")).toHaveClass("text-foreground");
    expect(screen.getByText("Två meningar.")).not.toHaveClass("text-muted-foreground");
  });

  it("puts the action in the header and the footer under a rule", () => {
    render(
      <SectionCard
        id="rules"
        title="Skolregler"
        action={<button type="button">Exportera</button>}
        footer={<button type="button">Spara</button>}
      >
        <p>fields</p>
      </SectionCard>,
    );

    const save = screen.getByRole("button", { name: "Spara" });
    expect(save.parentElement).toHaveClass("flex", "justify-end", "border-t", "pt-3");
    // The footer is the section's last block, after its body.
    expect(screen.getByText("fields").compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exportera" })).toBeInTheDocument();
  });

  it("merges a className onto the section", () => {
    render(<SectionCard id="rail" title="Räknare" className="lg:sticky" />);
    expect(screen.getByRole("region", { name: "Räknare" })).toHaveClass("lg:sticky", "bg-card");
  });
});
