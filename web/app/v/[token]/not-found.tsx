import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * Every link that does not resolve — malformed, unknown, revoked, switched
 * off, target gone, hidden or protected, or a viewer that is for staff — gets
 * this one page, as it gets the gateway's one 404: a guess learns nothing.
 * Both languages, since a not-found page is told neither the link's nor the
 * reader's.
 *
 * ONE LINE for staff, on every such page alike: a school may keep its viewer
 * for signed-in personnel, and its link is then "not found" to everyone who is
 * not signed in. The line says where to sign in and does not say whether it
 * applies; the page itself then asks once more as the person (read-as-staff).
 * The login has no way back to a link, so the line asks to open it again.
 *
 * ONE LINE to type a code, because a code is typed by hand and the commonest
 * slip is a letter: it leads to /v, where the code can be written again.
 */
export default function ViewerNotFound() {
  return (
    <main className="mx-auto max-w-xl space-y-6 px-4 py-16 text-center">
      <title>{`${sv.publicViewer.notFoundTitle} · ${en.publicViewer.notFoundTitle}`}</title>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{sv.publicViewer.notFoundTitle}</h1>
        <p>{sv.publicViewer.notFoundBody}</p>
        <p>
          {sv.publicViewer.notFoundStaff}{" "}
          <a href="/sv/login" className="underline underline-offset-4">
            {sv.publicViewer.notFoundStaffLogin}
          </a>{" "}
          {sv.publicViewer.notFoundStaffAfter}
        </p>
        <p>
          {sv.publicViewer.notFoundCode}{" "}
          <a href="/v" className="underline underline-offset-4">
            {sv.publicViewer.notFoundCodeLink}
          </a>
        </p>
      </div>
      <div lang="en" className="space-y-2">
        <h2 className="text-lg font-semibold">{en.publicViewer.notFoundTitle}</h2>
        <p>{en.publicViewer.notFoundBody}</p>
        <p>
          {en.publicViewer.notFoundStaff}{" "}
          <a href="/en/login" className="underline underline-offset-4">
            {en.publicViewer.notFoundStaffLogin}
          </a>{" "}
          {en.publicViewer.notFoundStaffAfter}
        </p>
        <p>
          {en.publicViewer.notFoundCode}{" "}
          <a href="/v?lang=en" className="underline underline-offset-4">
            {en.publicViewer.notFoundCodeLink}
          </a>
        </p>
      </div>
      <p className="text-xs">
        <a href="/sv/tillganglighet" className="underline underline-offset-4">
          {sv.publicViewer.accessibility}
        </a>
        {" · "}
        <a href="/en/tillganglighet" lang="en" className="underline underline-offset-4">
          {en.publicViewer.accessibility}
        </a>
      </p>
    </main>
  );
}
