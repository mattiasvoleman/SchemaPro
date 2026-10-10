import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * Every link that does not resolve — malformed, unknown, revoked, switched
 * off, target gone or hidden — gets this one page, as it gets the gateway's
 * one 404: a guess learns nothing. Both languages, since a not-found page is
 * told neither the link's nor the reader's.
 */
export default function ViewerNotFound() {
  return (
    <main className="mx-auto max-w-xl space-y-6 px-4 py-16 text-center">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{sv.publicViewer.notFoundTitle}</h1>
        <p>{sv.publicViewer.notFoundBody}</p>
      </div>
      <div lang="en" className="space-y-2">
        <h2 className="text-lg font-semibold">{en.publicViewer.notFoundTitle}</h2>
        <p>{en.publicViewer.notFoundBody}</p>
      </div>
    </main>
  );
}
