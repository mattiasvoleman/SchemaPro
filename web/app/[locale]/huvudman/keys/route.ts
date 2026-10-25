import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { huvudmanGateway } from "@/lib/huvudman";
import { fromThisApp } from "@/lib/request-origin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A new SS12000 key of the huvudman's (create-key-form.tsx): the one answer
 * that carries a secret, so it is JSON to the page that asked and never a
 * redirect, a cookie or an address. The gateway shows the key once and
 * keeps its hash; nothing here keeps anything.
 */
export async function POST(request: NextRequest) {
  if (!fromThisApp(request)) return new NextResponse(null, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "errorOther" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { huvudman?: unknown; name?: unknown; scopes?: unknown } | null;
  const huvudman = typeof body?.huvudman === "string" && UUID.test(body.huvudman) ? body.huvudman : null;
  if (!huvudman) return NextResponse.json({ error: "errorOther" }, { status: 400 });
  const answer = await huvudmanGateway<{ id: string; name: string; scopes: string[]; key: string }>(
    session.accessToken,
    "POST",
    `/api/v1/huvudman/${huvudman}/keys`,
    { name: body?.name, scopes: body?.scopes },
  );
  if (!answer.body) return NextResponse.json({ error: answer.code ?? "errorOther" }, { status: answer.status || 502 });
  return NextResponse.json(answer.body, { status: 201, headers: { "Cache-Control": "no-store" } });
}
