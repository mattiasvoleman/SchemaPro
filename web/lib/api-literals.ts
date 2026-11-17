import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

/**
 * Test support, not application code (nothing under app/, components/ or lib/
 * imports it): the `/api/v1/` strings a page of the web can reach through its
 * imports, found by reading the source with the TypeScript compiler.
 *
 * Used by teaching-admin.contract.test.ts to hold the table of "Min
 * undervisning" to the pages themselves. The table says which routes a page
 * calls; this says which routes the page's code could call, so that a hook
 * that starts asking for a colleague's route cannot do it unseen (LÅG-3 of the
 * review of #329).
 *
 * It follows SYMBOLS and not modules. A page that imports one hook from
 * lib/queries.ts reaches that hook and what it names, not the other three
 * hundred routes written in the same file; reading the module whole would put
 * every route the web has behind every page. A name is followed through its
 * own file's top-level declarations, through the named imports and the
 * re-exports it meets, and through `import()` (the whole of the module, since
 * a lazy component is its default and a dialog's chunk is its file). It does
 * not follow what it cannot name: a call through a value that is passed in
 * from somewhere else, or a path built from two constants (`${BASE}/mine`,
 * whose base is read here as a prefix and whose end is not). That is what
 * the table-to-web check in the contract test is for.
 */

export interface Literal {
  /** The path as written, with `${...}` as `:p` and no query string; no leading slash. */
  path: string;
  /** The file it is written in, relative to the web, and the top-level name it sits under. */
  file: string;
  name: string;
}

interface ImportRef {
  from: string | null;
  name: string;
}

interface Module {
  file: string;
  source: ts.SourceFile;
  decls: Map<string, ts.Node[]>;
  imports: Map<string, ImportRef>;
  reexports: Map<string, ImportRef>;
  stars: string[];
}

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export class ApiLiterals {
  private readonly modules = new Map<string, Module | null>();

  constructor(private readonly web: string) {}

  /** The literals reachable from the page files, each with where it sits. */
  reach(pages: readonly string[]): Literal[] {
    const found = new Map<string, Literal>();
    const visited = new Set<string>();
    const queue: [string, string][] = pages.map((page) => [resolve(this.web, page), "*"]);
    while (queue.length > 0) {
      const [file, name] = queue.pop()!;
      const key = `${file}::${name}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const module = this.read(file);
      if (!module) continue;
      const names = name === "*" ? [...module.decls.keys()] : [name];
      for (const each of names) {
        const nodes = module.decls.get(each);
        if (!nodes) {
          this.follow(module, each, queue);
          continue;
        }
        for (const node of nodes) this.scan(module, each, node, queue, found, name === "*");
      }
    }
    return [...found.values()];
  }

  /** The names a declaration refers to, and the strings and imports inside it. */
  private scan(module: Module, name: string, node: ts.Node, queue: [string, string][], found: Map<string, Literal>, whole: boolean): void {
    const here = (path: string) => {
      // One entry per file and path: a function that is also the file's default is the same code twice.
      if (!found.has(`${module.file}::${path}`)) found.set(`${module.file}::${path}`, { path, file: this.relative(module.file), name });
    };
    const visit = (child: ts.Node): void => {
      if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) {
        const path = normalise(child.text);
        if (path) here(path);
      } else if (ts.isTemplateExpression(child)) {
        const text = [child.head.text, ...child.templateSpans.flatMap((span) => [":p", span.literal.text])].join("");
        const path = normalise(text);
        if (path) here(path);
      } else if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = child.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          const target = this.resolveSpecifier(module.file, argument.text);
          if (target) queue.push([target, "*"]);
        }
      } else if (ts.isIdentifier(child) && !isPropertyName(child)) {
        if (child.text !== name || !whole) this.follow(module, child.text, queue);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }

  /** A name met in `module`: a declaration of its own file, an import, or a re-export. */
  private follow(module: Module, name: string, queue: [string, string][]): void {
    if (module.decls.has(name)) {
      queue.push([module.file, name]);
      return;
    }
    const via = module.imports.get(name) ?? module.reexports.get(name);
    if (via?.from) {
      queue.push([via.from, via.name]);
      return;
    }
    if (name === "default") {
      // `export default` of an identifier: the declaration it names.
      const alias = module.decls.get("default");
      if (alias) return;
    }
    for (const star of module.stars) queue.push([star, name]);
  }

  private read(file: string): Module | null {
    if (this.modules.has(file)) return this.modules.get(file)!;
    let module: Module | null = null;
    if (existsSync(file) && statSync(file).isFile() && /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file)) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      module = { file, source, decls: new Map(), imports: new Map(), reexports: new Map(), stars: [] };
      this.index(module);
    }
    this.modules.set(file, module);
    return module;
  }

  private index(module: Module): void {
    const add = (name: string, node: ts.Node) => module.decls.set(name, [...(module.decls.get(name) ?? []), node]);
    for (const statement of module.source.statements) {
      const exported = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
      const isDefault = exported.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const from = this.resolveSpecifier(module.file, statement.moduleSpecifier.text);
        const clause = statement.importClause;
        if (!clause) continue;
        if (clause.name) module.imports.set(clause.name.text, { from, name: "default" });
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) module.imports.set(bindings.name.text, { from, name: "*" });
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) module.imports.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        add(statement.name.text, statement);
        if (isDefault) add("default", statement);
      } else if (ts.isFunctionDeclaration(statement) && isDefault) {
        add("default", statement);
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        add(statement.name.text, statement);
        if (isDefault) add("default", statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
          else add("*destructured", declaration);
        }
      } else if (ts.isExportAssignment(statement)) {
        add("default", statement.expression);
      } else if (ts.isExportDeclaration(statement)) {
        const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? this.resolveSpecifier(module.file, statement.moduleSpecifier.text) : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            module.reexports.set(element.name.text, { from: from ?? module.file, name: (element.propertyName ?? element.name).text });
          }
        } else if (from) {
          module.stars.push(from);
        }
      }
    }
  }

  private resolveSpecifier(importer: string, specifier: string): string | null {
    const base = specifier.startsWith("@/") ? join(this.web, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(importer), specifier) : null;
    if (!base) return null;
    for (const extension of EXTENSIONS) {
      const candidate = `${base}${extension}`;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  private relative(file: string): string {
    return file.startsWith(this.web) ? file.slice(this.web.length + 1) : file;
  }
}

/** A property name (`x.name`, `{ name: 1 }`), which refers to no top-level declaration. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  return false;
}

/**
 * `/api/v1/leave-requests?x=1` is `api/v1/leave-requests`, and so is the template
 * `/api/v1/leave-requests${query}`: a hole glued to the text of the last segment is a query string. Anything
 * that does not start with `api/v1/` is no gateway path.
 */
function normalise(text: string): string | null {
  const bare = text.replace(/^\//, "").split("?")[0]!.replace(/\/+$/, "").replace(/([^/]):p$/, "$1");
  return /^api\/v1\/[\w:-]/.test(bare) || bare === "api/v1" ? bare : null;
}
