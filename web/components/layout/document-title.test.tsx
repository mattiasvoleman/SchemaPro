import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { APP_TITLES, appTitleFor, DocumentTitle, documentTitleOf } from "./document-title";

afterEach(() => {
  document.title = "";
  document.documentElement.lang = "";
});

describe("the app's name", () => {
  it("is the messages' common.appName in each language", () => {
    expect(APP_TITLES.sv).toBe(sv.common.appName);
    expect(APP_TITLES.en).toBe(en.common.appName);
  });

  it("follows the page's language, and is Swedish for anything else", () => {
    expect(appTitleFor("en")).toBe("Rastra timetable");
    expect(appTitleFor("sv")).toBe("Rastra Schema");
    expect(appTitleFor("")).toBe("Rastra Schema");
    expect(appTitleFor(undefined)).toBe("Rastra Schema");
  });
});

describe("documentTitleOf", () => {
  it("puts the page's own name before the app's", () => {
    expect(documentTitleOf("Timplan")).toBe("Timplan · Rastra Schema");
    expect(documentTitleOf("Timplan", "Rastra timetable")).toBe("Timplan · Rastra timetable");
  });

  it("is the app's name alone for an empty title", () => {
    expect(documentTitleOf("  ")).toBe("Rastra Schema");
  });
});

describe("DocumentTitle", () => {
  it("names the tab after the page, follows a new title and restores the old one on unmount", () => {
    document.title = "Rastra Schema";
    const { rerender, unmount, container } = render(<DocumentTitle title="Läsår" />);

    expect(document.title).toBe("Läsår · Rastra Schema");
    // It draws nothing.
    expect(container).toBeEmptyDOMElement();

    rerender(<DocumentTitle title="Rulla vidare" />);
    expect(document.title).toBe("Rulla vidare · Rastra Schema");

    unmount();
    expect(document.title).toBe("Rastra Schema");
  });

  it("names the tab in English on an English page", () => {
    document.documentElement.lang = "en";
    render(<DocumentTitle title="Timetable" />);
    expect(document.title).toBe("Timetable · Rastra timetable");
  });
});
