import { NextResponse, type NextRequest } from "next/server";
import { localePath } from "@/i18n/paths";
import { routing } from "@/i18n/routing";
import { getSession } from "@/lib/auth";
import { huvudmanGateway } from "@/lib/huvudman";
import { fromThisApp } from "@/lib/request-origin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The huvudman's pages' forms (app/[locale]/huvudman/page.tsx), without
 * client code: each posts here, this asks the gateway with the session's
 * token, and the answer is a 303 back to the page with what was done or
 * why not. The gateway and the database hold every act to the login's
 * membership; this only builds the request. Only from this app's own pages
 * (lib/request-origin.ts), as the school switcher.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: asked } = await params;
  const locale = (routing.locales as readonly string[]).includes(asked) ? asked : routing.defaultLocale;
  if (!fromThisApp(request)) return new NextResponse(null, { status: 403 });

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL(localePath(locale, "/login"), request.url), 303);

  const form = await request.formData().catch(() => null);
  const field = (name: string): string => {
    const value = form?.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const huvudman = field("huvudman");
  const back = (query: Record<string, string>, fragment = "huvudman-result") => {
    const url = new URL(localePath(locale, "/huvudman"), request.url);
    if (UUID.test(huvudman)) url.searchParams.set("h", huvudman);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    // The banner (or the question) is where the browser lands, and what a
    // screen reader reads first.
    url.hash = fragment;
    return NextResponse.redirect(url, 303);
  };
  // An act that cannot be taken back is asked about once more first: the
  // page shows the question with a second form that says yes (no client code).
  const confirmed = field("confirmed") === "yes";
  const ask = (target: string) => back({ confirm: field("action"), target }, "huvudman-confirm");
  if (!UUID.test(huvudman)) return back({ error: "errorOther" });

  const base = `/api/v1/huvudman/${huvudman}`;
  const id = (name: string): string | null => (UUID.test(field(name)) ? field(name) : null);
  const call = async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    huvudmanGateway<Record<string, unknown>>(session.accessToken, method, path, body);
  const refused = (code: string | null) => back({ error: code ?? "errorOther" });

  switch (field("action")) {
    case "request": {
      const answer = await call("POST", `${base}/requests`, { slug: field("slug").toLowerCase() });
      if (!answer.body) return refused(answer.code);
      // The page names the school from its own list, never from the address.
      return back({ done: "doneRequested", school: String(answer.body["id"] ?? "") });
    }
    case "withdraw": {
      const school = id("school");
      if (!school) return refused(null);
      const answer = await call("DELETE", `${base}/requests/${school}`);
      return answer.status === 204 ? back({ done: "doneWithdrawn" }) : refused(answer.code);
    }
    case "release": {
      const school = id("school");
      if (!school) return refused(null);
      if (!confirmed) return ask(school);
      const answer = await call("DELETE", `${base}/schools/${school}`);
      return answer.status === 204 ? back({ done: "doneReleased" }) : refused(answer.code);
    }
    case "invite": {
      const answer = await call("POST", `${base}/members`, {
        email: field("email"),
        firstName: field("firstName"),
        lastName: field("lastName"),
        role: field("role"),
      });
      if (!answer.body) return refused(answer.code);
      return back({ done: answer.body["emailSent"] ? "doneInvited" : "doneInvitedNoMail" });
    }
    case "member": {
      const member = id("member");
      if (!member) return refused(null);
      if (field("isActive") === "false" && !confirmed) return ask(member);
      const change: Record<string, unknown> = {};
      if (field("role")) change["role"] = field("role");
      if (field("isActive")) change["isActive"] = field("isActive") === "true";
      const answer = await call("PATCH", `${base}/members/${member}`, change);
      return answer.status === 204 ? back({ done: "doneUpdated" }) : refused(answer.code);
    }
    case "revoke": {
      const key = id("key");
      if (!key) return refused(null);
      if (!confirmed) return ask(key);
      const answer = await call("DELETE", `${base}/keys/${key}`);
      return answer.status === 204 ? back({ done: "doneRevoked" }) : refused(answer.code);
    }
    default:
      return refused(null);
  }
}
