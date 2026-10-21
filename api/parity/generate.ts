// The parity inventories: what the software offers, frozen so a consolidation
// can prove it neither lost nor added anything. Every inventory is canonical:
// sorted, no timestamps, no absolute paths, nothing that depends on the machine.
// `pnpm parity:update` writes them; api/parity/parity.test.ts regenerates and
// compares them.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// ---------- tRPC procedures: structure ----------

export type ProcedureEntry = { path: string; type: "query" | "mutation" | "subscription" };

/** Every procedure's dotted path and type, sorted by path. */
export async function procedures(): Promise<ProcedureEntry[]> {
  const { appRouter } = await import("../router");
  const record = (appRouter as unknown as { _def: { procedures: Record<string, { _def: { type: ProcedureEntry["type"] } }> } })._def.procedures;
  return Object.entries(record)
    .map(([p, proc]) => ({ path: p, type: proc._def.type }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------- tRPC procedures: materialized types ----------

const PROBE = path.join(ROOT, "api/parity/__probe.ts");
const PROBE_SOURCE = `import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../router";
export type ProbeIn = inferRouterInputs<AppRouter>;
export type ProbeOut = inferRouterOutputs<AppRouter>;
`;

class UnsupportedType extends Error {}

/** Union and intersection members in a stable order: by their shape, an alias's number left out (it is given later). */
const byShape = (a: string, b: string) => {
  const ka = a.replace(/\bRec\d+\b/g, "Rec");
  const kb = b.replace(/\bRec\d+\b/g, "Rec");
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The index of a JSON string literal's closing quote, from its opening one. */
function skipString(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return s.length;
}

/**
 * Prints types as standalone structure: no import, no name from the code
 * (only TypeScript's own Date, Map, Set). A recursive type becomes a numbered
 * alias, numbered in the order the sorted walk meets it. Anything else that
 * can't be written out (any, functions, classes, generics left open) fails.
 */
class Materializer {
  private readonly aliases = new Map<ts.Type, string>();
  private readonly bodies = new Map<string, string>();
  private readonly walking: ts.Type[] = [];
  private readonly recursive = new Set<ts.Type>();

  private readonly checker: ts.TypeChecker;
  private readonly where: string;

  constructor(checker: ts.TypeChecker, where: string) {
    this.checker = checker;
    this.where = where;
  }

  /**
   * The texts and the alias declarations, the aliases numbered in the order
   * the texts first name them (then their own bodies, breadth first): the
   * numbers no longer depend on the order the compiler happened to meet them.
   */
  canonical(texts: string[]): { texts: string[]; declarations: string } {
    const order = new Map<string, string>();
    const name = (old: string) => {
      if (!order.has(old)) order.set(old, `Rec${order.size + 1}`);
    };
    for (const text of texts) for (const m of text.matchAll(/\bRec\d+\b/g)) name(m[0]);
    for (let i = 0; i < order.size; i++) {
      const old = [...order.keys()][i];
      for (const m of (this.bodies.get(old) ?? "").matchAll(/\bRec\d+\b/g)) name(m[0]);
    }
    for (const old of [...this.bodies.keys()].sort()) name(old);
    const rename = (text: string) => text.replace(/\bRec\d+\b/g, (m) => order.get(m) ?? m);
    const declarations = [...this.bodies.entries()]
      .map(([old, body]) => [order.get(old) ?? old, rename(body)] as const)
      .sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3)))
      .map(([n, body]) => `type ${n} = ${body};`)
      .join("\n");
    return { texts: texts.map(rename), declarations };
  }

  print(t: ts.Type, at: string): string {
    const known = this.aliases.get(t);
    if (known) return known;
    if (this.walking.includes(t)) {
      this.recursive.add(t);
      const name = `Rec${this.aliases.size + 1}`;
      this.aliases.set(t, name);
      return name;
    }
    this.walking.push(t);
    try {
      const body = this.body(t, at);
      const name = this.aliases.get(t);
      if (name && this.recursive.has(t)) {
        this.bodies.set(name, body);
        return name;
      }
      return body;
    } finally {
      this.walking.pop();
    }
  }

  private fail(at: string, what: string): never {
    throw new UnsupportedType(`${this.where} ${at}: ${what} can't be materialized`);
  }

  private body(t: ts.Type, at: string): string {
    const c = this.checker;
    const f = t.flags;
    if (f & ts.TypeFlags.Any) this.fail(at, "any");
    if (f & ts.TypeFlags.Unknown) return "unknown";
    if (f & ts.TypeFlags.Never) return "never";
    if (f & ts.TypeFlags.Void) return "void";
    if (f & ts.TypeFlags.Undefined) return "undefined";
    if (f & ts.TypeFlags.Null) return "null";
    if (f & ts.TypeFlags.String) return "string";
    if (f & ts.TypeFlags.Number) return "number";
    if (f & ts.TypeFlags.BigInt) return "bigint";
    if (f & ts.TypeFlags.Boolean) return "boolean";
    if (f & ts.TypeFlags.BooleanLiteral) return c.typeToString(t);
    if (t.isStringLiteral()) return JSON.stringify(t.value);
    if (t.isNumberLiteral()) return String(t.value);
    if (f & ts.TypeFlags.TemplateLiteral) {
      const tl = t as ts.TemplateLiteralType;
      return "`" + tl.texts[0] + tl.types.map((x, i) => "${" + this.print(x, `${at}\${}`) + "}" + tl.texts[i + 1]).join("") + "`";
    }
    if (f & ts.TypeFlags.ESSymbolLike) this.fail(at, "a symbol");
    if (f & ts.TypeFlags.TypeParameter) this.fail(at, "an open type parameter");
    if (t.isUnion()) return [...new Set(t.types.map((x) => this.print(x, at)))].sort(byShape).join(" | ");
    if (t.isIntersection()) return [...new Set(t.types.map((x) => this.wrap(this.print(x, at))))].sort(byShape).join(" & ");
    if (f & ts.TypeFlags.Object) return this.object(t as ts.ObjectType, at);
    if (f & ts.TypeFlags.NonPrimitive) return "object";
    return this.fail(at, `a type of flags ${f}`);
  }

  /** A union or intersection inside an intersection or an array keeps its parentheses. */
  private wrap(s: string): string {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
      else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
      else if (ch === '"') i = skipString(s, i);
      else if (depth === 0 && (s.startsWith(" | ", i) || s.startsWith(" & ", i))) return `(${s})`;
    }
    return s;
  }

  private object(t: ts.ObjectType, at: string): string {
    const c = this.checker;
    if (c.isTupleType(t)) {
      const target = (t as ts.TupleTypeReference).target;
      const args = c.getTypeArguments(t as ts.TypeReference);
      const items = args.map((a, i) => {
        const flag = target.elementFlags[i];
        const s = this.print(a, `${at}[${i}]`);
        return flag & ts.ElementFlags.Rest ? `...${this.wrap(s)}[]` : flag & ts.ElementFlags.Optional ? `${this.wrap(s)}?` : s;
      });
      return `${target.readonly ? "readonly " : ""}[${items.join(", ")}]`;
    }
    if (c.isArrayType(t)) {
      const [item] = c.getTypeArguments(t as ts.TypeReference);
      const readonly = t.symbol?.name === "ReadonlyArray";
      return `${readonly ? "readonly " : ""}${this.wrap(this.print(item, `${at}[]`))}[]`;
    }
    const name = t.symbol?.name;
    const lib = t.symbol?.declarations?.every((d) => d.getSourceFile().hasNoDefaultLib) ?? false;
    if (lib && name === "Date") return "Date";
    if (lib && (name === "Map" || name === "Set")) {
      const args = c.getTypeArguments(t as ts.TypeReference).map((a, i) => this.print(a, `${at}<${i}>`));
      return `${name}<${args.join(", ")}>`;
    }
    if (c.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0) this.fail(at, "a function");
    if (c.getSignaturesOfType(t, ts.SignatureKind.Construct).length > 0) this.fail(at, "a class");
    if (lib && name !== "__type" && name !== "__object") this.fail(at, `the library type ${name}`);
    const parts: string[] = [];
    const str = c.getIndexInfoOfType(t, ts.IndexKind.String);
    if (str) parts.push(`${str.isReadonly ? "readonly " : ""}[key: string]: ${this.print(str.type, `${at}[string]`)}`);
    const num = c.getIndexInfoOfType(t, ts.IndexKind.Number);
    if (num) parts.push(`${num.isReadonly ? "readonly " : ""}[key: number]: ${this.print(num.type, `${at}[number]`)}`);
    const props = c.getPropertiesOfType(t).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const p of props) {
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
      const readonly = isReadonlyProperty(p);
      const key = /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name);
      parts.push(`${readonly ? "readonly " : ""}${key}${optional ? "?" : ""}: ${this.print(c.getTypeOfSymbol(p), `${at}.${p.name}`)}`);
    }
    return parts.length === 0 ? "{}" : `{ ${parts.join("; ")} }`;
  }
}

/** The program the server is checked with, plus the probe. */
function program(): { checker: ts.TypeChecker; probe: ts.SourceFile } {
  const configPath = path.join(ROOT, "tsconfig.server.json");
  const config = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, lang, onError, create) =>
    path.resolve(file) === PROBE ? ts.createSourceFile(file, PROBE_SOURCE, lang) : getSourceFile(file, lang, onError, create);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => path.resolve(file) === PROBE || fileExists(file);
  const p = ts.createProgram({ rootNames: [...parsed.fileNames, PROBE], options: { ...parsed.options, noEmit: true }, host });
  const probe = p.getSourceFile(PROBE);
  if (!probe) throw new Error("parity: the probe did not load");
  return { checker: p.getTypeChecker(), probe };
}

function exported(checker: ts.TypeChecker, probe: ts.SourceFile, name: string): ts.Type {
  const sym = checker.getSymbolAtLocation(probe);
  const s = sym && checker.getExportsOfModule(sym).find((e) => e.name === name);
  if (!s) throw new Error(`parity: ${name} missing from the probe`);
  return checker.getDeclaredTypeOfSymbol(s);
}

/** The type at a dotted path through nested router objects. */
function at(checker: ts.TypeChecker, root: ts.Type, dotted: string): ts.Type {
  let t = root;
  for (const seg of dotted.split(".")) {
    const p = checker.getPropertyOfType(t, seg);
    if (!p) throw new Error(`parity: no procedure type at ${dotted}`);
    t = checker.getTypeOfSymbol(p);
  }
  return t;
}

/** One type of a standalone source, materialized: how the walk is tested on small cases. */
export function materializeSource(source: string, typeName: string): string {
  const file = path.join(ROOT, "api/parity/__case.ts");
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) => (path.resolve(f) === file ? ts.createSourceFile(f, source, lang) : getSourceFile(f, lang, onError, create));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (f) => path.resolve(f) === file || fileExists(f);
  const p = ts.createProgram({ rootNames: [file], options, host });
  const checker = p.getTypeChecker();
  const sf = p.getSourceFile(file);
  if (!sf) throw new Error("parity: the case did not load");
  const m = new Materializer(checker, "case");
  const named = m.canonical([m.print(exported(checker, sf, typeName), typeName)]);
  return named.declarations ? `${named.declarations}\n${named.texts[0]}` : named.texts[0];
}

const HEADER = "// Generated by `pnpm parity:update` (api/parity/generate.ts): do not edit by hand.\n";

/**
 * The frozen contract and its compatibility checks, as two files' text:
 * - trpc-contract.ts: every procedure's input and output, written out in full;
 * - trpc-compat.ts: compiled by `tsc -b`, it holds the current router to the
 *   frozen one. Inputs: what an old client sent, the server still accepts
 *   (frozen assignable to current). Outputs: what the server returns, an old
 *   reader still reads (current assignable to frozen).
 */
export async function trpcContract(): Promise<{ contract: string; compat: string }> {
  const list = await procedures();
  const { checker, probe } = program();
  const ins = exported(checker, probe, "ProbeIn");
  const outs = exported(checker, probe, "ProbeOut");
  const m = new Materializer(checker, "tRPC");
  const rawIn = list.map((p) => `  ${JSON.stringify(p.path)}: ${m.print(at(checker, ins, p.path), `${p.path} input`)};`);
  const rawOut = list.map((p) => `  ${JSON.stringify(p.path)}: ${m.print(at(checker, outs, p.path), `${p.path} output`)};`);
  const named = m.canonical([...rawIn, ...rawOut]);
  const inLines = named.texts.slice(0, rawIn.length);
  const outLines = named.texts.slice(rawIn.length);
  const decls = named.declarations;
  const contract = [
    HEADER.trimEnd(),
    "// The tRPC contract as frozen at the baseline: standalone, nothing imported.",
    ...(decls ? ["", decls] : []),
    "",
    "export interface FrozenIn {",
    ...inLines,
    "}",
    "",
    "export interface FrozenOut {",
    ...outLines,
    "}",
    "",
  ].join("\n");
  const index = (dotted: string) => dotted.split(".").map((s) => `[${JSON.stringify(s)}]`).join("");
  const compat = [
    HEADER.trimEnd(),
    "// The current router held to the frozen contract (see generate.ts).",
    'import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";',
    'import type { AppRouter } from "../router";',
    'import type { FrozenIn, FrozenOut } from "./trpc-contract";',
    "",
    "type In = inferRouterInputs<AppRouter>;",
    "type Out = inferRouterOutputs<AppRouter>;",
    "/** Compiles only when A is assignable to B. */",
    "type Fits<A extends B, B> = [A, B];",
    "",
    "export type InputsStillAccepted = [",
    ...list.map((p) => `  Fits<FrozenIn[${JSON.stringify(p.path)}], In${index(p.path)}>,`),
    "];",
    "",
    "export type OutputsStillRead = [",
    ...list.map((p) => `  Fits<Out${index(p.path)}, FrozenOut[${JSON.stringify(p.path)}]>,`),
    "];",
    "",
  ].join("\n");
  return { contract, compat };
}

// ---------- Routes and settings sections ----------

export type RouteEntry = { path: string; guard: string | null };

/**
 * The app's routes, as App.tsx declares them, with the layout route that
 * guards each (RequireAuth, GuestOnly, or none): read with the TypeScript
 * parser, so attribute order or formatting don't matter. Sorted by path.
 */
export function routes(): RouteEntry[] {
  const sf = ts.createSourceFile("App.tsx", read("src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const attr = (el: ts.JsxOpeningLikeElement, name: string) => el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name);
  const tagOf = (el: ts.JsxOpeningLikeElement) => el.tagName.getText(sf);
  const out: RouteEntry[] = [];
  const walk = (node: ts.Node, guard: string | null) => {
    let inner = guard;
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening && tagOf(opening) === "Route") {
      const path = attr(opening, "path")?.initializer;
      const element = attr(opening, "element")?.initializer;
      if (path) {
        if (!ts.isStringLiteral(path)) throw new Error(`parity: a route path that isn't a literal: ${path.getText(sf)}`);
        out.push({ path: path.text, guard });
      } else if (element && ts.isJsxExpression(element) && element.expression && (ts.isJsxSelfClosingElement(element.expression) || ts.isJsxElement(element.expression))) {
        // A layout route without a path: what it renders guards its children.
        const e = element.expression;
        inner = tagOf(ts.isJsxElement(e) ? e.openingElement : e);
      }
    }
    ts.forEachChild(node, (child) => walk(child, inner));
  };
  walk(sf, null);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type SectionEntry = { id: string; nativeOnly: boolean; desktopOnly: boolean; permission: string | null };

/** The Settings categories in menu order (the order is part of what users see), and the old ids that still land. */
export function settingsSections(): { categories: SectionEntry[]; legacy: [string, string][] } {
  const src = read("src/components/settings/sections.tsx");
  const start = src.indexOf("export const CATEGORIES");
  const end = src.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error("parity: CATEGORIES not found");
  const block = src.slice(start, end);
  const chunks = block.split(/\n {2}\{\n/).slice(1);
  const categories = chunks.map((chunk) => {
    const id = /^\s*id: "([^"]+)"/m.exec(chunk)?.[1];
    if (!id) throw new Error("parity: a category without id");
    return {
      id,
      nativeOnly: /^\s*nativeOnly: true/m.test(chunk),
      desktopOnly: /^\s*desktopOnly: true/m.test(chunk),
      permission: /^\s*permission: "([^"]+)"/m.exec(chunk)?.[1] ?? null,
    };
  });
  const page = read("src/pages/Settings.tsx");
  const legacyBlock = /const LEGACY_SECTIONS[^{]*\{([^}]*)\}/.exec(page)?.[1] ?? "";
  const legacy = [...legacyBlock.matchAll(/(\w+): "([^"]+)"/g)].map((m): [string, string] => [m[1], m[2]]).sort();
  return { categories, legacy };
}

// ---------- i18n keys ----------

type Tree = { [key: string]: string | Tree };

function keysOf(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") return [p];
    const ks = Object.keys(v).sort().join(",");
    return ks === "one,other" ? [`${p} (plural)`] : keysOf(v, p);
  });
}

/** Every message key, per locale, sorted. */
export async function i18nKeys(): Promise<{ en: string[]; it: string[] }> {
  const { en } = await import("../../contracts/i18n/en");
  const { it } = await import("../../contracts/i18n/it");
  return { en: keysOf(en).sort(), it: keysOf(it).sort() };
}

// ---------- All of them ----------

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Every inventory file, by path relative to the repo root. */
export async function inventories(): Promise<Record<string, string>> {
  const { contract, compat } = await trpcContract();
  return {
    "api/parity/trpc-procedures.json": json(await procedures()),
    "api/parity/trpc-contract.ts": contract,
    "api/parity/trpc-compat.ts": compat,
    "api/parity/routes.json": json(routes()),
    "api/parity/settings-sections.json": json(settingsSections()),
    "api/parity/i18n-keys.json": json(await i18nKeys()),
  };
}

/**
 * A property's readonly: on its declaration, or, for one a mapped type made
 * (Readonly<…>, `{ readonly [K in …] }`, `-readonly`), on the symbol itself,
 * where only the compiler's check flags tell (not in its public types: checked
 * to be there, so a TypeScript without them fails here, never prints less).
 */
function isReadonlyProperty(p: ts.Symbol): boolean {
  if ((p.flags & ts.SymbolFlags.Transient) !== 0) {
    const internal = ts as unknown as { getCheckFlags?: (s: ts.Symbol) => number; CheckFlags?: { Readonly?: number } };
    const flag = internal.CheckFlags?.Readonly;
    if (!internal.getCheckFlags || flag === undefined) throw new Error("parity: this TypeScript has no getCheckFlags to tell a mapped property's readonly");
    if ((internal.getCheckFlags(p) & flag) !== 0) return true;
    const mapped = (internal.CheckFlags as { Mapped?: number }).Mapped;
    if (mapped !== undefined && (internal.getCheckFlags(p) & mapped) !== 0) return false;
  }
  const decl = p.valueDeclaration ?? p.declarations?.[0];
  return decl ? (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Readonly) !== 0 : false;
}
