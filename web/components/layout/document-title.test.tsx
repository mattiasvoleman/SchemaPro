import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DocumentTitle, documentTitleOf } from "./document-title";

afterEach(() => {
  document.title = "";
});

describe("documentTitleOf", () => {
  it("puts the page's own name before the app's", () => {
    expect(documentTitleOf("Timplan")).toBe("Timplan · SchemaPro");
  });

  it("is the app's name alone for an empty title", () => {
    expect(documentTitleOf("  ")).toBe("SchemaPro");
  });
});

describe("DocumentTitle", () => {
  it("names the tab after the page, follows a new title and restores the old one on unmount", () => {
    document.title = "SchemaPro";
    const { rerender, unmount, container } = render(<DocumentTitle title="Läsår" />);

    expect(document.title).toBe("Läsår · SchemaPro");
    // It draws nothing.
    expect(container).toBeEmptyDOMElement();

    rerender(<DocumentTitle title="Rulla vidare" />);
    expect(document.title).toBe("Rulla vidare · SchemaPro");

    unmount();
    expect(document.title).toBe("SchemaPro");
  });
});
