import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMBED_PATH, embedOriginsOf, embedTokenOf, forgetEmbedPolicies, frameAncestorsOf } from "./embed-policy";

/**
 * Who may frame /v/<token>/embed: the school's websites as the gateway lists
 * them, a minute's memory per token, and the frame shut whenever the answer
 * is anything but a list.
 */

const TOKEN = "T".repeat(43);
const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("frameAncestorsOf", () => {
  it("lists the websites, or none", () => {
    expect(frameAncestorsOf(["https://skolan.se", "https://www.skolan.se:8443"])).toBe(
      "frame-ancestors https://skolan.se https://www.skolan.se:8443",
    );
    expect(frameAncestorsOf(null)).toBe("frame-ancestors 'none'");
    expect(frameAncestorsOf([])).toBe("frame-ancestors 'none'");
  });

  it("never lets a value that is no origin into the header: no second directive, no wildcard, no http", () => {
    expect(frameAncestorsOf(["https://skolan.se; script-src *"])).toBe("frame-ancestors 'none'");
    expect(frameAncestorsOf(["*", "http://skolan.se", "https://ok.se"])).toBe("frame-ancestors https://ok.se");
  });

  it("takes a port a browser can have, and no other", () => {
    expect(frameAncestorsOf(["https://skolan.se:1", "https://skolan.se:65535"])).toBe(
      "frame-ancestors https://skolan.se:1 https://skolan.se:65535",
    );
    expect(frameAncestorsOf(["https://skolan.se:0", "https://skolan.se:65536", "https://skolan.se:99999", "https://skolan.se:08443"])).toBe(
      "frame-ancestors 'none'",
    );
  });
});

describe("EMBED_PATH", () => {
  it("is a share link's frame and nothing else", () => {
    expect(`/v/${TOKEN}/embed`.match(EMBED_PATH)?.[1]).toBe(TOKEN);
    expect(`/v/${TOKEN}/embed/`).toMatch(EMBED_PATH);
    expect(`/v/${TOKEN}`).not.toMatch(EMBED_PATH);
    expect(`/v/${TOKEN}/embed/x`).not.toMatch(EMBED_PATH);
    expect("/v/embed").not.toMatch(EMBED_PATH);
  });
});

describe("embedTokenOf", () => {
  const CODE = "K7QM2-X9DRT-4V8WN-B5C3H";

  it("names the link a frame's path holds, a token as it is", () => {
    expect(embedTokenOf(`/v/${TOKEN}/embed`)).toBe(TOKEN);
    expect(embedTokenOf(`/v/${TOKEN}/embed/`)).toBe(TOKEN);
  });

  it("reads a code in any spelling as the one link, so every spelling frames and is remembered alike", () => {
    for (const path of [
      `/v/${CODE}/embed`,
      "/v/k7qm2-x9drt-4v8wn-b5c3h/embed",
      "/v/K7QM2X9DRT4V8WNB5C3H/embed",
      // A typed space reaches the proxy as %20.
      "/v/k7qm2%20x9drt%204v8wn%20b5c3h/embed",
    ]) {
      expect(embedTokenOf(path)).toBe(CODE);
    }
  });

  it("is null for a path that is no share link's frame: such a page is framed by nobody", () => {
    for (const path of ["/v/short/embed", "/v/%E0%A4%A/embed", `/v/${TOKEN}`, `/v/${TOKEN}/embed/x`, "/v/K7QM2-X9DRT-4V8WN-B5C3/embed", "/sv/login"]) {
      expect(embedTokenOf(path)).toBeNull();
    }
  });
});

describe("embedOriginsOf", () => {
  const fetchImpl = vi.fn();
  beforeEach(() => {
    forgetEmbedPolicies();
    fetchImpl.mockReset();
  });
  const ask = (now = 1_000) => embedOriginsOf({ base: "http://gateway.internal/", token: TOKEN, headers: { "X-Viewer-Proxy-Key": "k" }, now, fetchImpl });

  it("asks the gateway's embed door with the viewer's headers, and keeps the answer for a minute", async () => {
    fetchImpl.mockResolvedValue(answer(200, { frameAncestors: ["https://skolan.se"] }));
    expect(await ask()).toEqual(["https://skolan.se"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://gateway.internal/public/v1/timetables/${TOKEN}/embed`,
      expect.objectContaining({ cache: "no-store", headers: { "X-Viewer-Proxy-Key": "k", Accept: "application/json" } }),
    );
    expect(await ask(60_000)).toEqual(["https://skolan.se"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValue(answer(404, { status: 404 }));
    expect(await ask(61_001)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps no 404, as the gateway says: a link the school has just let be embedded is framed at once", async () => {
    fetchImpl.mockResolvedValueOnce(answer(404, {}));
    expect(await ask()).toBeNull();
    fetchImpl.mockResolvedValueOnce(answer(200, { frameAncestors: ["https://skolan.se"] }));
    expect(await ask(2_000)).toEqual(["https://skolan.se"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shuts the frame, and remembers nothing, when the gateway fails or answers nonsense", async () => {
    fetchImpl.mockRejectedValueOnce(new Error("down"));
    expect(await ask()).toBeNull();
    fetchImpl.mockResolvedValueOnce(answer(429, {}));
    expect(await ask()).toBeNull();
    fetchImpl.mockResolvedValueOnce(answer(200, { frameAncestors: "https://skolan.se" }));
    expect(await ask()).toBeNull();
    fetchImpl.mockResolvedValueOnce(answer(200, { frameAncestors: ["https://skolan.se https://andra.se", 7] }));
    expect(await ask()).toBeNull();
    fetchImpl.mockResolvedValueOnce(answer(200, { frameAncestors: ["https://skolan.se"] }));
    expect(await ask()).toEqual(["https://skolan.se"]);
    // Only the failures before the good answer were asked again.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
