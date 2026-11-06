import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ViewerNotFound from "./not-found";

/**
 * Every link that does not resolve gets this one page, in both languages. It
 * says nothing about why — only where a code is typed and, once per language,
 * where staff sign in.
 */
describe("the viewer's not-found page", () => {
  it("offers staff the login once in each language, without saying whether it applies", () => {
    render(<ViewerNotFound />);
    const login = screen.getAllByRole("link", { name: /Logga in|Sign in/ });
    expect(login.map((link) => link.getAttribute("href"))).toEqual(["/sv/login", "/en/login"]);
    expect(screen.getByText(/Är du personal\?/)).toHaveTextContent("Är du personal? Logga in och öppna länken igen.");
    expect(screen.getByText(/Are you staff\?/)).toHaveTextContent("Are you staff? Sign in and open the link again.");
  });

  it("leads to the page where a code is typed, and still says nothing of which case it was", () => {
    const { container } = render(<ViewerNotFound />);
    expect(screen.getByRole("link", { name: "Skriv in den här." })).toHaveAttribute("href", "/v");
    expect(screen.getByRole("link", { name: "Type it here." })).toHaveAttribute("href", "/v?lang=en");
    expect(screen.getByRole("heading", { level: 1, name: "Schemat finns inte" })).toBeInTheDocument();
    // The cause is not named: not revoked, not off, not hidden, not for staff.
    expect(container.textContent).not.toMatch(/endast personal|bara inloggad|hidden|staff-only|dold/i);
    expect(document.title).toBe("Schemat finns inte · No such timetable");
  });
});
