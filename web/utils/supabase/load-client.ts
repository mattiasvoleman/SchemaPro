/**
 * The Supabase browser client, fetched when a form first needs it.
 *
 * The client is ~63KB gzipped, two thirds of the JavaScript /login used to
 * ship, and the unauthenticated pages only touch it when somebody submits.
 * Imported statically it was downloaded and evaluated before the page could
 * answer a tap, for every visitor, including the ones who never sign in.
 *
 * `warmClient` starts the download as soon as somebody focuses a field, so a
 * submit seldom has to wait for it; `loadClient` is what the submit awaits.
 *
 * Both share ONE import() promise rather than calling import() twice. Two
 * overlapping import() calls for the same module are not guaranteed to agree:
 * Vitest's mocker handed the second one the real module while the first was
 * still in flight, which is exactly the focus-then-click sequence of a sign-in.
 * A rejected promise is dropped, so this layer never pins a failure.
 *
 * `loadClient` rejects when the chunk cannot be fetched — offline, or a deploy
 * replaced the chunk under an open tab. Callers must turn that into something
 * the user can see; a static import had no such failure mode. Whether a later
 * attempt can succeed depends on the browser's and the bundler's own chunk
 * caches, so callers should not promise one.
 */
let pending: Promise<typeof import("./client")> | undefined;

function importClient() {
  pending ??= import("./client").catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

export async function loadClient() {
  const { createClient } = await importClient();
  return createClient();
}

export function warmClient(): void {
  // A failed warm-up is not an error yet; the submit awaits the import itself
  // and reports the failure there.
  importClient().catch(() => {});
}
