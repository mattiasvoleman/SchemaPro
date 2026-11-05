import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES, formatOfFileNames, saveBase64, toBase64 } from "./schedule-exchange";

describe("formatOfFileNames", () => {
  it("knows a single file by its extension", () => {
    expect(formatOfFileNames(["schema.csv"])).toBe("TABLE_CSV");
    expect(formatOfFileNames(["Schema.XLSX"])).toBe("TABLE_XLSX");
    expect(formatOfFileNames(["export.xml"])).toBe("ASC_XML");
    expect(formatOfFileNames(["rastra-schema-untis.zip"])).toBe("UNTIS_GPU");
  });

  it("knows the Untis files, loose, with or without the extension", () => {
    expect(formatOfFileNames(["GPU001.TXT", "GPU002.TXT", "GPU011.TXT"])).toBe("UNTIS_GPU");
    expect(formatOfFileNames(["gpu001", "gpu011"])).toBe("UNTIS_GPU");
    expect(formatOfFileNames(["GPU001.TXT"])).toBe("UNTIS_GPU");
  });

  it("does not guess when the names do not say", () => {
    expect(formatOfFileNames([])).toBeNull();
    expect(formatOfFileNames(["schema.pdf"])).toBeNull();
    expect(formatOfFileNames(["a.csv", "b.csv"])).toBeNull();
    expect(formatOfFileNames(["GPU001.TXT", "schema.csv"])).toBeNull();
  });
});

describe("toBase64", () => {
  it("encodes a file’s bytes, also past the size one spread can carry", async () => {
    expect(await toBase64(new Blob(["åäö;1"], { type: "text/csv" }))).toBe(Buffer.from("åäö;1", "utf8").toString("base64"));
    const big = new Uint8Array(0x8000 * 3 + 5).map((_, i) => i % 251);
    expect(await toBase64(new Blob([big]))).toBe(Buffer.from(big).toString("base64"));
  });

  it("holds an upload to what the gateway’s body limit takes once it is base64", () => {
    // 1 MB of JSON, base64 a third larger than the bytes, and the rest of the body.
    expect(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3)).toBeLessThan(1024 * 1024);
  });
});

describe("saveBase64", () => {
  const originals = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  afterEach(() => {
    URL.createObjectURL = originals.create;
    URL.revokeObjectURL = originals.revoke;
    vi.restoreAllMocks();
  });

  it("hands the bytes to the browser as a download with the file’s name and type", async () => {
    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((made: Blob) => {
      blob = made;
      return "blob:made";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let anchor: HTMLAnchorElement | null = null;
    click.mockImplementation(function (this: HTMLAnchorElement) {
      anchor = this;
    });

    saveBase64("schema.csv", "text/csv", Buffer.from("a;b\r\n", "utf8").toString("base64"));

    expect(anchor).not.toBeNull();
    expect(anchor!.download).toBe("schema.csv");
    expect(anchor!.href).toBe("blob:made");
    expect(blob!.type).toBe("text/csv");
    expect(await blob!.text()).toBe("a;b\r\n");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:made");
  });
});
