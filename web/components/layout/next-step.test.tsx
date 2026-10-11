import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { NextStep } from "./next-step";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The real Swedish copy, so the test pins the sentence a user reads.
vi.mock("next-intl", async () => {
  const sv = (await import("@/messages/sv.json")).default as unknown as Record<string, Record<string, string>>;
  return {
    useTranslations: (namespace: string) => (key: string, values?: Record<string, string>) =>
      Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, value),
        sv[namespace]![key]!,
      ),
  };
});

describe("NextStep", () => {
  it("links forward to the next page by its name", () => {
    render(<NextStep href="/admin/requirements" name="Timplansposter" />);

    const next = screen.getByRole("link", { name: "Nästa steg: Timplansposter" });
    expect(next).toHaveAttribute("href", "/admin/requirements");
  });

  it("is a quiet ghost button that never prints", () => {
    render(<NextStep href="/admin/gaps" name="Luckor och håltimmar" className="ml-auto" />);

    const next = screen.getByRole("link");
    expect(next).toHaveClass("print:hidden", "ml-auto", "h-8");
    expect(next).not.toHaveClass("bg-primary");
    expect(next.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
