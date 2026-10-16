import { describe, expect, it } from "vitest";
import { feedUrl } from "./calendar-feed";

/** A feed's address, as a calendar asks it: the gateway's own origin, ending in .ics. */
describe("feedUrl", () => {
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

  it("is the gateway's public feed path, whatever trailing slash the base has", () => {
    expect(feedUrl(token, "https://api.schema.example")).toBe(`https://api.schema.example/public/v1/calendar-feeds/${token}.ics`);
    expect(feedUrl(token, "https://api.schema.example//")).toBe(`https://api.schema.example/public/v1/calendar-feeds/${token}.ics`);
  });
});
