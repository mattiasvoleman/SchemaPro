import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module captures NEXT_PUBLIC_API_BASE_URL at import time, so every test
// re-imports it after stubbing the environment.
const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/supabase/client", () => ({
  createClient: vi.fn(() => ({ auth: { getSession: getSessionMock } })),
}));

const fetchMock = vi.fn();

const loadApi = async () => await import("./api");

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("api client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.test");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "tok-1" } },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("GETs against the configured base URL with a bearer token and no body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await loadApi();

    await expect(api.get("/lessons")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.test/lessons");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: "Bearer tok-1" });
    // No body and no Content-Type on a body-less request.
    expect("body" in init).toBe(false);
  });

  it("POSTs a JSON body with a Content-Type header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "new" }, 201));
    const { api } = await loadApi();

    await expect(api.post("/lessons", { subjectId: "s1" })).resolves.toEqual({ id: "new" });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.test/lessons");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer tok-1",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ subjectId: "s1" }));
  });

  it("omits body and Content-Type for a body-less POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const { api } = await loadApi();

    await api.post("/solver/run");

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toEqual({ Authorization: "Bearer tok-1" });
    expect("body" in init).toBe(false);
  });

  it("maps patch and delete onto the matching HTTP methods", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));
    const { api } = await loadApi();

    await api.patch("/lessons/1", { note: "x" });
    await api.delete("/lessons/1");

    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("PATCH");
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe("DELETE");
  });

  it("resolves undefined for a 204 response without touching the body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { api } = await loadApi();
    await expect(api.delete("/lessons/1")).resolves.toBeUndefined();
  });

  it("rejects with a 401 ApiError before fetching when there is no session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const { api, ApiError } = await loadApi();

    const error = await api.get("/lessons").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 401,
      message: "Not authenticated.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers the problem `detail` field when mapping an error response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Room is double-booked." }, 409));
    const { api } = await loadApi();
    await expect(api.post("/lessons", {})).rejects.toMatchObject({
      status: 409,
      message: "Room is double-booked.",
    });
  });

  it("falls back to the `message` field when there is no detail", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Forbidden." }, 403));
    const { api } = await loadApi();
    await expect(api.get("/admin")).rejects.toMatchObject({
      status: 403,
      message: "Forbidden.",
    });
  });

  it("keeps a generic HTTP message for a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 502 }));
    const { api } = await loadApi();
    await expect(api.get("/lessons")).rejects.toMatchObject({
      status: 502,
      message: "HTTP 502",
    });
  });

  it("strips a trailing slash from the base URL rather than building a double slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.test/");
    vi.resetModules();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = await loadApi();

    await api.post("/api/v1/academic-years", { name: "2026/2027" });

    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.test/api/v1/academic-years");
  });

  it("rejects with status 0 when the base URL is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    vi.resetModules();
    const { api } = await loadApi();

    await expect(api.get("/lessons")).rejects.toMatchObject({
      status: 0,
      message: "NEXT_PUBLIC_API_BASE_URL is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // The config check fires before the auth lookup.
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("exposes ApiError as an Error subclass", async () => {
    const { ApiError } = await loadApi();
    const error = new ApiError(418, "teapot");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(418);
    expect(error.message).toBe("teapot");
  });
});
