/**
 * The modules a module reaches, and what in them could talk to the network or keep something: a tool for the tests that prove the
 * pseudonymiser (Pseudonymiseraren, X1) makes no request and stores nothing. Not a product module.
 *
 * It reads the TypeScript SYNTAX TREE, not the text, so a comment that says "no fetch" or a string that holds "XMLHttpRequest" is not a
 * finding and a call is. It follows every `import`, `export … from` and `import()` whose specifier is local (`@/…`, `./…`, `../…`) into
 * the file it names, and collects every other specifier as a package. Nothing is executed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const WEB_ROOT = resolve(__dirname, "../..");

/** Identifiers that are, or open, a way out of the page, or keep something in the browser. */
const BANNED_IDENTIFIERS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "ServiceWorker",
  "importScripts",
  "sendBeacon",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "RTCPeerConnection",
]);
/** `a.<name>` that is a way out or a store, whatever `a` is: document.cookie, navigator.sendBeacon, navigator.serviceWorker, form.submit(), x.postMessage(). */
const BANNED_PROPERTIES = new Set(["cookie", "sendBeacon", "serviceWorker", "submit", "postMessage"]);
/** Navigating away with data in the address: location.href = …, location.assign(…), location.replace(…). (`anchor.href = blobUrl`, the download, is not this, and `string.replace` is not.) */
const LOCATION_PROPERTIES = new Set(["href", "assign", "replace", "reload"]);
/** JSX elements that load, send or frame something. `<a download>` is not one of them. */
const BANNED_ELEMENTS = new Set(["form", "iframe", "script", "link", "embed", "object", "img", "video", "audio", "source", "track", "meta", "base"]);

export interface Finding {
  file: string;
  what: string;
}

export interface Closure {
  /** Paths of the local files reached, relative to web/. */
  files: string[];
  /** Every package specifier imported anywhere in them. */
  packages: string[];
  findings: Finding[];
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(WEB_ROOT, specifier.slice(2)) : resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base]) {
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

const isLocal = (specifier: string): boolean => specifier.startsWith("@/") || specifier.startsWith("./") || specifier.startsWith("../");

/** The files and packages reached from the entry files, and anything in the files that could reach out. */
export function closureOf(entries: readonly string[]): Closure {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const findings: Finding[] = [];
  const queue = entries.map((entry) => resolve(WEB_ROOT, entry));

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rel = file.slice(WEB_ROOT.length + 1);

    const follow = (specifier: string): void => {
      if (!isLocal(specifier)) {
        packages.add(specifier);
        return;
      }
      const target = resolveLocal(file, specifier);
      if (target === null) findings.push({ file: rel, what: `import of ${specifier} that does not resolve` });
      else queue.push(target);
    };

    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        // A type-only import is erased and carries nothing.
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
        if (!typeOnly) follow(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument !== undefined && ts.isStringLiteralLike(argument)) follow(argument.text);
        else findings.push({ file: rel, what: "import() of something that is not a string" });
      } else if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
        // A property of that name (`x.fetch`) is the property rule's; a declaration of that name is a local. Both are still reported: nothing here has a reason to use the names.
        findings.push({ file: rel, what: `identifier ${node.text}` });
      } else if (ts.isPropertyAccessExpression(node) && BANNED_PROPERTIES.has(node.name.text)) {
        findings.push({ file: rel, what: `property .${node.name.text}` });
      } else if (ts.isPropertyAccessExpression(node) && node.name.text === "open" && /^(window|globalThis|self|top|parent)$/.test(node.expression.getText(source))) {
        findings.push({ file: rel, what: "window.open" });
      } else if (ts.isPropertyAccessExpression(node) && LOCATION_PROPERTIES.has(node.name.text) && /(^|\.)location$/.test(node.expression.getText(source))) {
        findings.push({ file: rel, what: `location.${node.name.text}` });
      } else if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && BANNED_ELEMENTS.has(node.tagName.getText(source))) {
        findings.push({ file: rel, what: `element <${node.tagName.getText(source)}>` });
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Image") {
        findings.push({ file: rel, what: "new Image()" });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { files: [...seen].map((file) => file.slice(WEB_ROOT.length + 1)).sort(), packages: [...packages].sort(), findings };
}
