/**
 * A file handed to the person at the keyboard (Pseudonymiseraren, X1): a Blob, an object URL and a click on an anchor, the way lib/csv-export.ts
 * hands over text. The bytes are made in the browser and go from the browser's memory to a file on the person's own disk; nothing here asks anyone for anything.
 */

export function saveBytes(filename: string, bytes: Uint8Array, contentType: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked a moment later: a browser that starts the download on the click still needs the address for a tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** UTF-8 text, as a file. */
export function saveText(filename: string, text: string, contentType = "text/plain;charset=utf-8"): void {
  saveBytes(filename, new TextEncoder().encode(text), contentType);
}
