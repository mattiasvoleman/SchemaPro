import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import type { MySchool } from "@/lib/types";
import { SchoolSwitcher } from "./school-switcher";

/**
 * The school switcher (Flera skolor per inloggning): rendered on the server,
 * a <details> and a form that posts to /[locale]/skola. The list is the
 * login's schools as the gateway gives them; a school the session may not
 * enter is listed with why, and cannot be chosen.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: keyof typeof sv) => (key: string, values?: Record<string, string>) => {
    const text = (sv[namespace] as Record<string, string>)[key] ?? key;
    return Object.entries(values ?? {}).reduce((out, [name, value]) => out.replace(`{${name}}`, value), text);
  },
}));

const school = (id: string, name: string, extra: Partial<MySchool> = {}): MySchool => ({
  schoolId: id,
  schoolName: name,
  role: "TEACHER",
  adminProfile: null,
  closed: null,
  current: false,
  ...extra,
});

const A = school("33333333-3333-4333-8333-333333333333", "Ekbacken", { current: true });
const B = school("44444444-4444-4444-8444-444444444444", "Granen", { role: "SCHOOL_ADMIN", adminProfile: "FULL" });
const C = school("55555555-5555-4555-8555-555555555555", "Hagen", { role: "GUARDIAN", closed: "sso_required" });

describe("SchoolSwitcher", () => {
  it("is just the school's name for a login with one school", async () => {
    const { container } = render(await SchoolSwitcher({ schools: [A], currentName: "Ekbacken", locale: "sv" }));
    expect(container.textContent).toBe("Ekbacken");
    expect(container.querySelector("details, form, button")).toBeNull();
  });

  it("is the name too when the list could not be read", async () => {
    const { container } = render(await SchoolSwitcher({ schools: [], currentName: "Ekbacken", locale: "sv" }));
    expect(container.textContent).toBe("Ekbacken");
  });

  it("lists every school as a button of one form that posts to the locale's /skola", async () => {
    const { container } = render(await SchoolSwitcher({ schools: [A, B, C], currentName: "Ekbacken", locale: "en" }));
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/en/skola");
    const buttons = within(form).getAllByRole("button");
    expect(buttons.map((button) => [button.getAttribute("name"), button.getAttribute("value")])).toEqual([
      ["school", A.schoolId],
      ["school", B.schoolId],
      ["school", C.schoolId],
    ]);
    expect(screen.getByText("Byt skola")).toHaveClass("sr-only");
  });

  it("marks the chosen school, and offers neither it nor a closed one", async () => {
    render(await SchoolSwitcher({ schools: [A, B, C], currentName: "Ekbacken", locale: "sv" }));
    const chosen = screen.getByRole("button", { name: /Ekbacken/ });
    expect(chosen).toBeDisabled();
    expect(chosen).toHaveAttribute("aria-current", "true");
    expect(chosen).toHaveTextContent("Lärare, vald nu");
    expect(screen.getByRole("button", { name: /Granen/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Granen/ })).toHaveTextContent("Administratör");
    const closed = screen.getByRole("button", { name: /Hagen/ });
    expect(closed).toBeDisabled();
    expect(closed).toHaveTextContent("Skolan kräver skolkonto");
  });

  it("says for whom a school is read as its huvudman's läsare (Huvudman)", async () => {
    const read = school("66666666-6666-4666-8666-666666666666", "Lunden", {
      role: "SCHOOL_ADMIN",
      adminProfile: "LASARE",
      huvudman: { id: "h", name: "Vimmerby kommun", role: "PLANERARE", memberId: "m", firstName: "Pia", lastName: "P" },
    });
    render(await SchoolSwitcher({ schools: [A, read], currentName: "Ekbacken", locale: "sv" }));
    const button = screen.getByRole("button", { name: /Lunden/ });
    expect(button.textContent).toContain("Läsare för Vimmerby kommun");
    expect(button).not.toBeDisabled();
  });

  it("links a huvudman's member back to the huvudman's pages, even with one school (Huvudman)", async () => {
    const { container } = render(await SchoolSwitcher({ schools: [A], currentName: "Ekbacken", locale: "sv", huvudmanHref: "/sv/huvudman" }));
    expect(container.querySelector("details")).not.toBeNull();
    const link = screen.getByRole("link", { name: sv.schoolSwitcher.huvudmanPages });
    expect(link).toHaveAttribute("href", "/sv/huvudman");
    // Outside the switcher's form: following it posts nothing.
    expect(link.closest("form")).toBeNull();
  });
});
