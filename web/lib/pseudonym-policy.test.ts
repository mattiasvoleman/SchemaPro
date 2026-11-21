import { describe, expect, it } from "vitest";
import { isPseudonymiseraPath, pseudonymiserarePolicy } from "@/lib/pseudonym-policy";

/** The directives of a policy as a map; a directive is one name and its sources. */
function directives(policy: string): Map<string, string> {
  return new Map(policy.split(";").map((part) => part.trim()).filter(Boolean).map((part) => [part.split(" ")[0]!, part.slice(part.indexOf(" ") + 1)]));
}

describe("the policy of the pseudonymiser's page", () => {
  const production = directives(pseudonymiserarePolicy());

  it("refuses every way the page could send something: connect, forms, frames, plug-ins, workers, pictures with an address in them", () => {
    expect(production.get("connect-src")).toBe("'none'");
    expect(production.get("form-action")).toBe("'none'");
    expect(production.get("frame-src")).toBe("'none'");
    expect(production.get("object-src")).toBe("'none'");
    expect(production.get("worker-src")).toBe("'none'");
    expect(production.get("img-src")).toBe("data: blob:");
    expect(production.get("base-uri")).toBe("'none'");
    expect(production.get("frame-ancestors")).toBe("'none'");
  });

  it("starts from nothing: every kind of resource not named is refused", () => {
    expect(production.get("default-src")).toBe("'none'");
    // The kinds the page needs, and no more: its own scripts and styles, its own fonts.
    expect([...production.keys()].sort()).toEqual(
      ["base-uri", "connect-src", "default-src", "font-src", "form-action", "frame-ancestors", "frame-src", "img-src", "manifest-src", "media-src", "object-src", "script-src", "style-src", "worker-src"].sort(),
    );
  });

  it("lets no source in but the page's own, and nothing from another site in any directive", () => {
    for (const [name, sources] of production) {
      expect(sources, name).not.toMatch(/https?:|\*|ws:|wss:/);
    }
    expect(production.get("script-src")).toBe("'self' 'unsafe-inline'");
    expect(production.get("script-src")).not.toContain("unsafe-eval");
  });

  it("opens the websocket of Next's hot reload in development, and a production policy never has it", () => {
    const development = directives(pseudonymiserarePolicy({ development: true }));
    expect(development.get("connect-src")).toBe("'self' ws: wss:");
    expect(development.get("script-src")).toContain("'unsafe-eval'");
    expect(pseudonymiserarePolicy()).not.toContain("ws:");
    expect(pseudonymiserarePolicy({ development: false })).toBe(pseudonymiserarePolicy());
  });
});

describe("isPseudonymiseraPath", () => {
  it.each(["/sv/pseudonymisera", "/en/pseudonymisera", "/sv/pseudonymisera/"])("is true for %s", (path) => {
    expect(isPseudonymiseraPath(path)).toBe(true);
  });

  it.each(["/pseudonymisera", "/sv/pseudonymisera/x", "/sv/pseudonymiserare", "/sv/login", "/de/pseudonymisera", "/sv/admin/pseudonymisera", "/v/pseudonymisera"])("is false for %s", (path) => {
    expect(isPseudonymiseraPath(path)).toBe(false);
  });
});
