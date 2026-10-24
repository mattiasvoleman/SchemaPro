import { afterEach, describe, expect, it } from "vitest";
import { SCHOOL_COOKIE, SCHOOL_META, cookieSchool, pageSchool, schoolHeaders, schoolIdOf } from "./school-choice";

const A = "33333333-3333-4333-8333-333333333333";

describe("the school a request names (Flera skolor per inloggning)", () => {
  afterEach(() => {
    document.head.querySelectorAll(`meta[name="${SCHOOL_META}"]`).forEach((meta) => meta.remove());
    document.cookie = `${SCHOOL_COOKIE}=; max-age=0; path=/`;
  });

  it("reads a school id in any case and with spaces, and nothing else", () => {
    expect(schoolIdOf(` ${A.toUpperCase()} `)).toBe(A);
    expect(schoolIdOf("skolan")).toBeNull();
    expect(schoolIdOf(`${A}x`)).toBeNull();
    expect(schoolIdOf("")).toBeNull();
    expect(schoolIdOf(null)).toBeNull();
  });

  it("names a school in the header only when there is one to name", () => {
    expect(schoolHeaders(A)).toEqual({ "x-school-id": A });
    expect(schoolHeaders(null)).toEqual({});
    // A value that is no school id is never sent: the gateway would refuse it,
    // and the database would answer it with no row.
    expect(schoolHeaders("skolan")).toEqual({});
  });

  it("takes the page's school from the layout's meta, and none on a page without one", () => {
    expect(pageSchool()).toBeNull();
    const meta = document.createElement("meta");
    meta.name = SCHOOL_META;
    meta.content = A;
    document.head.append(meta);
    expect(pageSchool()).toBe(A);
  });

  it("reads the browser's choice from the cookie, which another tab may have changed", () => {
    expect(cookieSchool()).toBeNull();
    document.cookie = `other=1; path=/`;
    document.cookie = `${SCHOOL_COOKIE}=${A}; path=/`;
    expect(cookieSchool()).toBe(A);
  });
});
