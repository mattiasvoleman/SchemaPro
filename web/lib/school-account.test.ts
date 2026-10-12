import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LookupBusyError,
  SSO_REASONS,
  forgetLookups,
  emailDomain,
  isSsoReason,
  isSsoRequired,
  lookupProvider,
  providerHints,
  providerScopes,
  schoolAccountAddressOf,
  ssoReasonFor,
} from "./school-account";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

describe("emailDomain", () => {
  it("answers the domain of an address, trimmed and lower case", () => {
    expect(emailDomain("  Anna.Andersson@Skola.Example ")).toBe("skola.example");
    expect(emailDomain("a@b@elev.skola.example")).toBe("elev.skola.example");
  });

  it("answers nothing for an address without a domain worth asking about", () => {
    for (const email of ["", "anna", "@skola.example", "anna@", "anna@localhost", "anna@skola..example", "anna@10.0.0.1", "anna@skola example"]) {
      expect(emailDomain(email)).toBeNull();
    }
  });
});

describe("lookupProvider", () => {
  beforeEach(() => forgetLookups());

  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("asks the gateway's public route about the domain, uncached", async () => {
    const fetcher = respond({ provider: "google" });
    await expect(lookupProvider("https://api.example//", "skola.example", fetcher)).resolves.toBe("google");
    expect(fetcher).toHaveBeenCalledWith("https://api.example/public/v1/sign-in-methods/skola.example", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  });

  it("answers null for no provider and for anything it does not know", async () => {
    await expect(lookupProvider("https://api.example", "skola.example", respond({ provider: null }))).resolves.toBeNull();
    await expect(lookupProvider("https://api.example", "skola.example", respond({ provider: "github" }))).resolves.toBeNull();
    await expect(lookupProvider("https://api.example", "skola.example", respond({}))).resolves.toBeNull();
  });

  it("throws a busy error on 429 and another on any other refusal, and remembers neither", async () => {
    await expect(lookupProvider("https://api.example", "skola.example", respond({}, 429))).rejects.toBeInstanceOf(LookupBusyError);
    const failure = await lookupProvider("https://api.example", "skola.example", respond({}, 500)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(LookupBusyError);
    await expect(lookupProvider("https://api.example", "skola.example", respond({ provider: "azure" }))).resolves.toBe("azure");
  });

  it("remembers a domain's answer, the absence of one too, for the page's life", async () => {
    const azure = respond({ provider: "azure" });
    await lookupProvider("https://api.example", "skola.example", azure);
    await expect(lookupProvider("https://api.example", "skola.example", azure)).resolves.toBe("azure");
    const none = respond({ provider: null });
    await lookupProvider("https://api.example", "okand.example", none);
    await expect(lookupProvider("https://api.example", "okand.example", none)).resolves.toBeNull();
    expect(azure).toHaveBeenCalledTimes(1);
    expect(none).toHaveBeenCalledTimes(1);
  });
});

describe("providerHints", () => {
  it("gives Entra the address and the domain, and Google the address", () => {
    expect(providerHints("azure", " anna@skola.example ", "skola.example")).toEqual({
      login_hint: "anna@skola.example",
      domain_hint: "skola.example",
    });
    expect(providerHints("google", "anna@skola.example", "skola.example")).toEqual({ login_hint: "anna@skola.example" });
  });
});

describe("providerScopes", () => {
  it("asks Entra for the address, and leaves Google to its own scopes", () => {
    expect(providerScopes("azure")).toBe("email");
    expect(providerScopes("google")).toBeUndefined();
  });
});

describe("isSsoRequired", () => {
  it("recognises the hook's refusal and nothing else", () => {
    expect(isSsoRequired({ status: 403, message: "sso_required" })).toBe(true);
    expect(isSsoRequired({ status: 400, message: "Invalid login credentials" })).toBe(false);
    expect(isSsoRequired({ status: 403, message: "sso_identity_not_allowed" })).toBe(false);
    expect(isSsoRequired({ message: "sso_required" })).toBe(false);
    expect(isSsoRequired(null)).toBe(false);
  });
});

describe("ssoReasonFor", () => {
  it("names each refusal Auth and the hook give, and failed for the rest", () => {
    expect(ssoReasonFor("signup_disabled")).toBe("no-account");
    expect(ssoReasonFor("provider_email_needs_verification")).toBe("unverified");
    expect(ssoReasonFor("email_not_confirmed")).toBe("unverified");
    expect(ssoReasonFor("sso_identity_not_allowed")).toBe("other-organisation");
    expect(ssoReasonFor("sso_not_enabled")).toBe("not-enabled");
    expect(ssoReasonFor("access_denied")).toBe("cancelled");
    expect(ssoReasonFor("consent_required")).toBe("cancelled");
    expect(ssoReasonFor("interaction_required")).toBe("cancelled");
    expect(ssoReasonFor("user_banned")).toBe("blocked");
    expect(ssoReasonFor("flow_state_expired")).toBe("failed");
    expect(ssoReasonFor(null)).toBe("failed");
    expect(ssoReasonFor(undefined)).toBe("failed");
  });

  it("only ever answers a reason the sign-in page has a sentence for, in both languages", () => {
    for (const reason of SSO_REASONS) {
      expect(isSsoReason(reason)).toBe(true);
      expect(sv.auth.ssoReasons[reason]).toEqual(expect.any(String));
      expect(en.auth.ssoReasons[reason]).toEqual(expect.any(String));
    }
    expect(Object.keys(sv.auth.ssoReasons).sort()).toEqual([...SSO_REASONS].sort());
    expect(isSsoReason("javascript:alert(1)")).toBe(false);
    expect(isSsoReason(["failed"])).toBe(false);
  });
});

describe("schoolAccountAddressOf", () => {
  it("answers the address of a session that signed in with a school account", () => {
    expect(schoolAccountAddressOf({ email: "anna@skola.example", amr: [{ method: "oauth", timestamp: 1 }] })).toBe("anna@skola.example");
  });

  it("answers nothing for a password session, an empty address or no claims", () => {
    expect(schoolAccountAddressOf({ email: "anna@skola.example", amr: [{ method: "password" }] })).toBeNull();
    expect(schoolAccountAddressOf({ email: "", amr: [{ method: "oauth" }] })).toBeNull();
    expect(schoolAccountAddressOf({ amr: [{ method: "oauth" }] })).toBeNull();
    expect(schoolAccountAddressOf({ email: "anna@skola.example", amr: "oauth" })).toBeNull();
    expect(schoolAccountAddressOf({ email: "anna@skola.example", amr: [null, "oauth"] })).toBeNull();
    expect(schoolAccountAddressOf(null)).toBeNull();
    expect(schoolAccountAddressOf(undefined)).toBeNull();
  });
});
