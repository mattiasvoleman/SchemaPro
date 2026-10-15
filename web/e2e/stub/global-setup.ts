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
          "Stop it, or give this run ports of its own: E2E_STUB_PORT and E2E_WEB_PORT together " +
          "(the app is built against the stub's port, so a run that moves only the stub would " +
          "test the other run's app).",
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
      throw new Error(`The backend stub had no fixture for these reads; each says where to add it:\n  ${missed.join("\n  ")}`);
    }
  };
}
