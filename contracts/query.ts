// The search language, shared by the app and the server: free text, keys and
// links, and operators in English or Italian (`project:APP stato:"In corso"
// -label:bug priority>=high updated:7d @me`), with `-` to exclude, `OR` and
// parentheses. Parsing never fails: what isn't an operator is text, and
// what can't be read is said in `warnings`. Saved queries are kept in English
// (`formatQuery(q, "en")`) and shown in the user's language.

export type QueryField =
  | "client"
  | "project"
  | "source"
  | "status"
  | "cat"
  | "assignee"
  | "author"
  | "type"
  | "label"
  | "component"
  | "priority"
  | "updated"
  | "created"
  | "due"
  | "logged"
  | "sprint"
  | "is"
  | "field";

export type QueryOp = "=" | "<" | "<=" | ">" | ">=";

export type QueryTerm =
  | { kind: "text"; text: string }
  /** An issue key or a link to one: resolved directly. */
  | { kind: "ref"; ref: string }
  /** @me: assigned to one of my accounts. */
  | { kind: "me" }
  /** `field.<name>` carries the field's name. */
  | { kind: "field"; field: QueryField; op: QueryOp; value: string; name?: string };

export type QueryExpr = QueryTerm | { kind: "and"; items: QueryExpr[] } | { kind: "or"; items: QueryExpr[] } | { kind: "not"; item: QueryExpr };

export type QueryWarning = { code: "unknownField" | "badValue" | "unbalanced" | "emptyValue"; at: string };
export type ParsedQuery = { expr: QueryExpr | null; warnings: QueryWarning[] };

type Lang = "en" | "it";

/** Each field: its name per language (the first is how it's written back) and the names it is also read by. */
const FIELDS: Record<QueryField, { en: string; it: string; also?: string[] }> = {
  client: { en: "client", it: "cliente", also: ["customer"] },
  project: { en: "project", it: "progetto", also: ["proj"] },
  source: { en: "in", it: "in", also: ["source", "fonte", "from", "da"] },
  status: { en: "status", it: "stato" },
  cat: { en: "cat", it: "cat", also: ["category", "categoria"] },
  assignee: { en: "assignee", it: "assegnata", also: ["assigned", "assegnatario", "assegnato"] },
  author: { en: "author", it: "autore", also: ["reporter", "creator", "creatore"] },
  type: { en: "type", it: "tipo" },
  label: { en: "label", it: "etichetta", also: ["labels", "tag"] },
  component: { en: "component", it: "componente", also: ["components", "componenti"] },
  priority: { en: "priority", it: "priorità", also: ["priorita", "prio"] },
  updated: { en: "updated", it: "aggiornata", also: ["aggiornato"] },
  created: { en: "created", it: "creata", also: ["creato"] },
  due: { en: "due", it: "scadenza", also: ["scade"] },
  logged: { en: "logged", it: "loggata", also: ["registrata", "loggato"] },
  sprint: { en: "sprint", it: "ciclo", also: ["cycle", "iteration", "iterazione"] },
  is: { en: "is", it: "è", also: ["e"] },
  field: { en: "field", it: "campo" },
};

const BY_NAME = new Map<string, QueryField>(
  (Object.entries(FIELDS) as [QueryField, (typeof FIELDS)[QueryField]][]).flatMap(([f, d]) => [d.en, d.it, ...(d.also ?? [])].map((n) => [n, f] as const)),
);

/** Values of `is:` and `cat:` in both languages, to their canonical English. */
const IS_VALUES: Record<string, string> = {
  open: "open", aperta: "open", aperto: "open",
  closed: "closed", chiusa: "closed", chiuso: "closed",
  watched: "watched", watching: "watched", osservata: "watched", seguita: "watched",
  favorite: "favorite", preferita: "favorite", fav: "favorite",
  unread: "unread", nonletta: "unread", nuova: "unread",
  hidden: "hidden", nascosta: "hidden",
};
const IS_IT: Record<string, string> = { open: "aperta", closed: "chiusa", watched: "osservata", favorite: "preferita", unread: "nonletta", hidden: "nascosta" };

const CAT_VALUES: Record<string, string> = {
  triage: "triage", smistamento: "triage",
  backlog: "backlog",
  todo: "todo", dafare: "todo", "da-fare": "todo",
  doing: "doing", inprogress: "doing", incorso: "doing", "in-corso": "doing",
  done: "done", fatta: "done", fatto: "done",
  cancelled: "cancelled", canceled: "cancelled", annullata: "cancelled",
  closed: "closed", chiusa: "closed",
};
const CAT_IT: Record<string, string> = { triage: "smistamento", backlog: "backlog", todo: "dafare", doing: "incorso", done: "fatta", cancelled: "annullata", closed: "chiusa" };

/** Priority names to the layer's rank (0 = most important). */
const PRIORITY_RANKS: Record<string, number> = {
  highest: 0, massima: 0, blocker: 0, bloccante: 0, critical: 0, critica: 0, urgent: 0, urgente: 0,
  high: 1, alta: 1,
  medium: 2, media: 2, normal: 2, normale: 2,
  low: 3, bassa: 3,
  lowest: 4, minima: 4, trivial: 4, banale: 4,
};
const PRIORITY_EN = ["highest", "high", "medium", "low", "lowest"];
const PRIORITY_IT = ["massima", "alta", "media", "bassa", "minima"];

/** Names some trackers use beside the five levels, as the nearest level (the Board's filter). */
const PRIORITY_NEAR: Record<string, number> = { major: 1, maggiore: 1, minor: 3, minore: 3 };

/** The filterable priority levels, highest first. */
export const PRIORITY_LEVELS = [0, 1, 2, 3, 4] as const;

/**
 * An issue's priority level: the rank its tracker gave (0 highest … 4 lowest),
 * else what its name says (any language the trackers use), else null.
 */
export function priorityLevel(rank: number | null, name: string): number | null {
  if (rank !== null && rank >= 0 && rank <= 4) return rank;
  const k = name.trim().toLowerCase();
  if (!k) return null;
  return k in PRIORITY_RANKS ? PRIORITY_RANKS[k] : (PRIORITY_NEAR[k] ?? null);
}

/** A priority value as a rank, or null when it isn't one. */
export function priorityRankOfValue(v: string): number | null {
  const k = v.toLowerCase();
  if (k in PRIORITY_RANKS) return PRIORITY_RANKS[k];
  return /^[0-4]$/.test(k) ? Number(k) : null;
}

/** Keys as trackers write them: APP-12, owner/repo#12, group/project#12. */
const KEY_RE = /^(?:[A-Za-z][A-Za-z0-9_]*-\d+|[A-Za-z0-9][\w.-]*(?:\/[\w.-]+)+#\d+)$/;
const URL_RE = /^https?:\/\/\S+$/i;
const DATE_FIELDS = new Set<QueryField>(["updated", "created", "due", "logged"]);

// ---------- Dates ----------

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A date value as a span of local days [from, to): null when it isn't a date. */
export function daySpan(value: string, now: Date): { from: Date; to: Date } | null {
  const v = value.toLowerCase();
  const today = startOfDay(now);
  const range = /^(.+)\.\.(.+)$/.exec(v);
  if (range) {
    const a = daySpan(range[1], now);
    const b = daySpan(range[2], now);
    return a && b ? { from: a.from, to: b.to } : null;
  }
  if (v === "today" || v === "oggi") return { from: today, to: addDays(today, 1) };
  if (v === "yesterday" || v === "ieri") return { from: addDays(today, -1), to: today };
  if (v === "tomorrow" || v === "domani") return { from: addDays(today, 1), to: addDays(today, 2) };
  if (v === "week" || v === "settimana") {
    // Weeks start on Monday.
    const from = addDays(today, -((today.getDay() + 6) % 7));
    return { from, to: addDays(from, 7) };
  }
  if (v === "month" || v === "mese") {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from, to: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
  }
  // The last N days (today included): 7d / 7g, 2w / 2s.
  const rel = /^(\d{1,4})(d|g|w|s)$/.exec(v);
  if (rel) {
    const days = Number(rel[1]) * (rel[2] === "w" || rel[2] === "s" ? 7 : 1);
    return { from: addDays(today, 1 - days), to: addDays(today, 1) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) || d.getDate() !== Number(iso[3]) ? null : { from: d, to: addDays(d, 1) };
  }
  return null;
}

/** What a date operator keeps, as instants: `updated:7d` (in the span), `<` before it, `>` after it. */
export function dateBounds(op: QueryOp, value: string, now: Date): { from?: Date; to?: Date } | null {
  const s = daySpan(value, now);
  if (!s) return null;
  if (op === "=") return s;
  if (op === "<") return { to: s.from };
  if (op === "<=") return { to: s.to };
  if (op === ">") return { from: s.to };
  return { from: s.from };
}

// ---------- Tokens ----------

type Token = { t: "word"; v: string; quoted: boolean; neg: boolean } | { t: "("; neg: boolean } | { t: ")" } | { t: "or" };

function tokenize(input: string, warnings: QueryWarning[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    let neg = false;
    if ((c === "-" || c === "!") && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      neg = true;
      i++;
    }
    if (s[i] === "(") {
      out.push({ t: "(", neg });
      i++;
      continue;
    }
    if (s[i] === ")") {
      out.push({ t: ")" });
      i++;
      continue;
    }
    if (s[i] === "|") {
      out.push({ t: "or" });
      i++;
      continue;
    }
    // A word: up to whitespace or a parenthesis, with "quoted parts" kept whole.
    let v = "";
    let quoted = false;
    while (i < s.length && !/\s/.test(s[i]) && s[i] !== "(" && s[i] !== ")") {
      if (s[i] === '"') {
        quoted = true;
        const end = s.indexOf('"', i + 1);
        if (end < 0) {
          warnings.push({ code: "unbalanced", at: s.slice(i) });
          v += s.slice(i + 1);
          i = s.length;
        } else {
          v += s.slice(i + 1, end);
          i = end + 1;
        }
      } else v += s[i++];
    }
    if (!quoted && !neg && v === "OR") out.push({ t: "or" });
    else out.push({ t: "word", v, quoted, neg });
  }
  return out;
}

// ---------- Terms ----------

/** `field:value`, `field:>=value`, `priority>=high`, `field.Story points:>3`. */
const FIELD_RE = /^([\p{L}_][\p{L}\p{N}_]*)(?:\.([^:<>=]+))?(:(?:>=|<=|>|<|=)?|>=|<=|>|<)(.*)$/su;

function termOf(word: string, quoted: boolean, warnings: QueryWarning[]): QueryTerm | null {
  if (quoted && !FIELD_RE.test(word)) return word.trim() ? { kind: "text", text: word } : null;
  const lower = word.toLowerCase();
  if (lower === "@me" || lower === "@io" || lower === "@mie" || lower === "@mine") return { kind: "me" };
  if (URL_RE.test(word) || KEY_RE.test(word)) return { kind: "ref", ref: word };
  const m = FIELD_RE.exec(word);
  if (m) {
    const field = BY_NAME.get(m[1].toLowerCase());
    if (!field) {
      warnings.push({ code: "unknownField", at: word });
      return { kind: "text", text: word };
    }
    const sign = m[3].replace(/^:/, "");
    const op = (sign === "" ? "=" : sign) as QueryOp;
    const value = m[4];
    if (!value) {
      warnings.push({ code: "emptyValue", at: word });
      return null;
    }
    if (field === "field" && !m[2]) {
      warnings.push({ code: "badValue", at: word });
      return { kind: "text", text: word };
    }
    const bad =
      (DATE_FIELDS.has(field) && !daySpan(value, new Date())) ||
      (field === "priority" && priorityRankOfValue(value) === null && op !== "=") ||
      (field === "is" && !(value.toLowerCase() in IS_VALUES)) ||
      (field === "cat" && !(value.toLowerCase() in CAT_VALUES)) ||
      (op !== "=" && !["priority", "field", ...DATE_FIELDS].includes(field));
    if (bad) {
      warnings.push({ code: "badValue", at: word });
      return null;
    }
    // Known values in English (a priority's name by its rank): one query, whichever language wrote it.
    const rank = field === "priority" ? priorityRankOfValue(value) : null;
    const canon =
      field === "is" ? IS_VALUES[value.toLowerCase()] : field === "cat" ? CAT_VALUES[value.toLowerCase()] : rank !== null && !/^\d$/.test(value) ? PRIORITY_EN[rank] : value;
    return { kind: "field", field, op, value: canon, ...(m[2] ? { name: m[2].trim() } : {}) };
  }
  // A state word on its own (osservata, preferita…) reads as is: — never one typed in quotes.
  if (lower in BARE_IS) return { kind: "field", field: "is", op: "=", value: BARE_IS[lower] };
  return word ? { kind: "text", text: word } : null;
}

/**
 * State words that say is: without it. Only the ones no title would use as
 * a plain word (not open/aperta, closed/chiusa, which are searched as words).
 */
const BARE_IS: Record<string, string> = {
  osservata: "watched", osservate: "watched", seguita: "watched", seguite: "watched",
  preferita: "favorite", preferite: "favorite",
  nonletta: "unread", nonlette: "unread",
  nascosta: "hidden", nascoste: "hidden",
};

// ---------- Expressions ----------

const and = (items: QueryExpr[]): QueryExpr | null => (items.length === 0 ? null : items.length === 1 ? items[0] : { kind: "and", items });

/** Parses a query: AND binds tighter than OR; `-` negates a term or a group. */
export function parseQuery(input: string): ParsedQuery {
  const warnings: QueryWarning[] = [];
  const tokens = tokenize(input.slice(0, 1000), warnings);
  let i = 0;

  const group = (): QueryExpr | null => {
    const alternatives: QueryExpr[] = [];
    let current: QueryExpr[] = [];
    while (i < tokens.length) {
      const tk = tokens[i];
      if (tk.t === ")") break;
      i++;
      if (tk.t === "or") {
        const a = and(current);
        if (a) alternatives.push(a);
        current = [];
        continue;
      }
      if (tk.t === "(") {
        const inner = group();
        if (tokens[i]?.t === ")") i++;
        else warnings.push({ code: "unbalanced", at: "(" });
        if (inner) current.push(tk.neg ? { kind: "not", item: inner } : inner);
        continue;
      }
      const term = termOf(tk.v, tk.quoted, warnings);
      if (term) current.push(tk.neg ? { kind: "not", item: term } : term);
    }
    const a = and(current);
    if (a) alternatives.push(a);
    return alternatives.length === 0 ? null : alternatives.length === 1 ? alternatives[0] : { kind: "or", items: alternatives };
  };

  let expr = group();
  // A stray ")" closes nothing: skip it and read on.
  while (i < tokens.length) {
    warnings.push({ code: "unbalanced", at: ")" });
    i++;
    const rest = group();
    if (rest) expr = expr ? { kind: "and", items: [expr, rest] } : rest;
  }
  return { expr, warnings };
}

// ---------- Writing back ----------

const quote = (v: string) => (/[\s()"]/.test(v) || v === "" ? `"${v.replaceAll('"', "")}"` : v);

/** Fields whose value can be the user themselves (me / io). */
const PERSON_FIELDS = new Set<QueryField>(["assignee", "author"]);

function valueIn(field: QueryField, value: string, lang: Lang): string {
  if (PERSON_FIELDS.has(field) && /^@?(me|io)$/i.test(value)) return lang === "it" ? "io" : "me";
  if (lang === "en") {
    if (field === "priority") {
      const r = priorityRankOfValue(value);
      return r === null ? value : PRIORITY_EN[r];
    }
    return value;
  }
  if (field === "is") return IS_IT[value] ?? value;
  if (field === "cat") return CAT_IT[value] ?? value;
  if (field === "priority") {
    const r = priorityRankOfValue(value);
    return r === null ? value : PRIORITY_IT[r];
  }
  return value;
}

/** The query written in one language: what a saved query is stored as (en) and shown as. */
export function formatQuery(expr: QueryExpr | null, lang: Lang = "en"): string {
  if (!expr) return "";
  const w = (e: QueryExpr, nested: boolean): string => {
    switch (e.kind) {
      case "text":
        return quote(e.text);
      case "ref":
        return e.ref;
      case "me":
        return lang === "it" ? "@io" : "@me";
      case "field": {
        const name = FIELDS[e.field][lang] + (e.name ? `.${quote(e.name)}` : "");
        return `${name}:${e.op === "=" ? "" : e.op}${quote(valueIn(e.field, e.value, lang))}`;
      }
      case "not":
        return `-${e.item.kind === "and" || e.item.kind === "or" ? `(${w(e.item, false)})` : w(e.item, true)}`;
      case "and":
        return e.items.map((x) => w(x, true)).join(" ");
      case "or": {
        const s = e.items.map((x) => w(x, true)).join(" OR ");
        return nested ? `(${s})` : s;
      }
    }
  };
  return w(expr, false);
}

/** Every field name, for completion: in the user's language first. */
export function queryFieldNames(lang: Lang): { field: QueryField; name: string }[] {
  return (Object.keys(FIELDS) as QueryField[]).map((f) => ({ field: f, name: FIELDS[f][lang] }));
}

/** The plain words of a query (its text terms, not negated): what a tracker's text search gets. */
export function queryText(expr: QueryExpr | null): string {
  if (!expr) return "";
  if (expr.kind === "text") return expr.text;
  if (expr.kind === "and") return expr.items.map(queryText).filter(Boolean).join(" ");
  return "";
}
