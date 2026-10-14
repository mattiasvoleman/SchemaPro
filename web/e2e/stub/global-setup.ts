import type { Server } from "node:http";
import { missedRequests, startStub } from "./server";

/**
 * Starts the backend stub (server.ts) for the whole run, in the runner's own
 * process — so its TypeScript loads through Playwright, and it is gone when
 * the run is. The Next.js server is built against its origin
 * (playwright.config.ts); the public pages never call it.
 */
export default async function globalSetup() {
  let server: Server;
  try {
    server = await startStub();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        "The e2e backend stub's port is taken — another Playwright run is probably using it. " +
          "Stop it, or set E2E_STUB_PORT for both runs' builds.",
      );
    }
    throw error;
  }
  return async () => {
    // Next's fetch keeps its connections alive; close would wait them out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The specs fail on a miss the browser saw; this catches the ones the
    // Next.js server made while rendering (the session, /admin's counts).
    const missed = missedRequests();
    if (missed.length > 0) {
      throw new Error(`The backend stub had no fixture for:\n  ${missed.join("\n  ")}\nAdd them under e2e/stub/fixtures/.`);
    }
  };
}
