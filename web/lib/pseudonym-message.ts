/**
 * A message with {name} and {name, plural, one {…} other {…}} in it, filled in (Pseudonymiseraren, X1).
 *
 * The page is public and carries no next-intl client runtime (the unauthenticated routes resolve their text on the server, as the sign-in page
 * does, and keep the catalogue out of the browser). Its sentences have counts in them ("3 filer", "1 fil"), so the page hands the client the
 * RAW messages in the catalogue's own ICU syntax and this fills them in. Only what the catalogue uses is read: a name, and a plural of `one` and
 * `other` (with # for the number), one level deep. Nothing else is: a message with anything more in it is shown as it is, which a test of the
 * catalogue sees before a school does.
 */

export type MessageValues = Readonly<Record<string, string | number>>;

/** The index of the brace that closes the one opened at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `one {…} other {…}` as { one, other }. */
function branchesOf(body: string): Record<string, string> {
  const branches: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const open = body.indexOf("{", at);
    if (open === -1) break;
    const name = body.slice(at, open).trim();
    const close = closingBrace(body, open);
    if (close === -1) break;
    branches[name] = body.slice(open + 1, close);
    at = close + 1;
  }
  return branches;
}

export function formatMessage(template: string, values: MessageValues = {}, locale = "sv"): string {
  let out = "";
  let at = 0;
  while (at < template.length) {
    const open = template.indexOf("{", at);
    if (open === -1) {
      out += template.slice(at);
      break;
    }
    out += template.slice(at, open);
    const close = closingBrace(template, open);
    if (close === -1) {
      out += template.slice(open);
      break;
    }
    const inside = template.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inside);
    if (plural !== null) {
      const value = values[plural[1]!];
      const branches = branchesOf(plural[2]!);
      const category = typeof value === "number" ? new Intl.PluralRules(locale).select(value) : "other";
      const chosen = branches[`=${value}`] ?? branches[category] ?? branches["other"] ?? "";
      out += formatMessage(chosen.replace(/#/g, String(value ?? "")), values, locale);
    } else if (/^\s*\w+\s*$/.test(inside) && values[inside.trim()] !== undefined) {
      out += String(values[inside.trim()]);
    } else {
      out += template.slice(open, close + 1);
    }
    at = close + 1;
  }
  return out;
}
