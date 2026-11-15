// Placeholders are gaps for facts the AI wasn't given, written [[like this]] or, by some models,
// [Like This]. The writer is told never to write them; these helpers find any that are left (also
// in drafts written before that rule), fill them with the author's details, and list the passages
// that still have one so the AI can rewrite them without the missing fact.

/** [[anything]] (group 1) or a single-bracket [Label] (group 2, checked with looksLikePlaceholder). */
export const ANY_PLACEHOLDER = /\[\[([^[\]\n]{1,200})\]\]|(?<!\[)\[([^[\]\n]{2,80})\](?!\])/g;

const HINT = /\b(names?|authors?|writers?|institutions?|institutes?|university|universities|affiliations?|departments?|organi[sz]ations?|company|companies|date|year|number|e-?mail|address|city|country|location|grant|funder|funding|committee|approval|insert|enter|your|tbd|todo|placeholder|reference needed)\b/i;
const NOT_A_GAP = /^(sic|emphasis|italics|translat|original|ed\.|eds\.|et al|ibid|…|\.\.\.)/i;
const SMALL_WORDS = /^(of|the|and|or|for|in|at|to|a|an|on|&)$/i;

/** True for a single-bracket note that stands for a missing fact, such as [Author Name] or [insert date]. */
export function looksLikePlaceholder(inner: string) {
  const text = String(inner || "").trim();
  if (text.length < 2 || text.length > 80 || /\d/.test(text) || NOT_A_GAP.test(text)) return false;
  if (!/^\p{L}[\p{L}'’&/ ,.()-]*$/u.test(text)) return false;
  if (HINT.test(text)) return true;
  const words = text.split(/\s+/);
  return words.length <= 6 && /^\p{Lu}/u.test(words[0]) && words.every((w) => /^\p{Lu}/u.test(w) || SMALL_WORDS.test(w));
}

export const placeholderKey = (label: string) => String(label || "").trim().toLowerCase().split(/\s+/).join(" ");

// Citations are ids of real, checked records ([R3], shown in the chosen reference style), never
// placeholders. Review advice that calls them placeholders, asks about "[R#]" or wants them
// "replaced with real sources" is wrong and is dropped.
const CITATIONS_AS_PLACEHOLDERS = /place-?holders?\W+(?:\w+\W+){0,3}?(?:citations?|references?|sources?|bibliograph)|(?:citations?|references?|bibliograph\w*)\W+(?:\w+\W+){0,4}?place-?holders?|\[\s*R\s*[#\dxXn]|(?<![\w-])R#|citation (?:keys?|markers?|tags?|ids?)\b/i;

/** True for review advice that is wrong about placeholders: calling citations placeholders, or any placeholder talk when none are left. */
export function wrongAboutPlaceholders(text: string, count: number) {
  const value = String(text || "");
  return CITATIONS_AS_PLACEHOLDERS.test(value) || (count === 0 && /place-?holder/i.test(value));
}

export interface Found { key: string; label: string; count: number }
type Path = (string | number)[];

/** Each placeholder in a piece of text. */
export function placeholdersIn(text: string) {
  const out: { index: number; length: number; label: string }[] = [];
  for (const m of String(text || "").matchAll(new RegExp(ANY_PLACEHOLDER.source, "g"))) {
    if (m[1] === undefined && !looksLikePlaceholder(m[2])) continue;
    out.push({ index: m.index ?? 0, length: m[0].length, label: (m[1] ?? m[2]).trim() });
  }
  return out;
}

/** Replace the placeholders that have a value (keyed by placeholderKey); others stay. */
export function replaceIn(text: string, values: Record<string, string>) {
  return String(text ?? "").replace(new RegExp(ANY_PLACEHOLDER.source, "g"), (whole, double, single) => {
    if (double === undefined && !looksLikePlaceholder(single)) return whole;
    const value = String(values[placeholderKey(double ?? single)] ?? "").trim();
    return value || whole;
  });
}

// Notes to the author aren't part of the document.
const SKIP = new Set(["author_notes"]);

function* strings(value: any, path: Path = []): Generator<[Path, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i += 1) yield* strings(value[i], [...path, i]);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (!SKIP.has(key)) yield* strings(item, [...path, key]);
  }
}

/** Every text in the draft (for counting a find-and-replace). */
export const textsOf = (draft: any) => [...strings(draft)].map(([, text]) => text);

/** The draft with `change` applied to every text in it. */
export function mapStrings(value: any, change: (text: string) => string, key = ""): any {
  if (SKIP.has(key)) return value;
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, change, k)]));
  return value;
}

/** The placeholders in a draft, one entry per distinct label, in reading order. */
export function findPlaceholders(draft: any): Found[] {
  const found = new Map<string, Found>();
  for (const [, text] of strings(draft)) {
    for (const p of placeholdersIn(text)) {
      const key = placeholderKey(p.label);
      const item = found.get(key);
      if (item) item.count += 1;
      else found.set(key, { key, label: p.label, count: 1 });
    }
  }
  return [...found.values()];
}

export const countPlaceholders = (draft: any) => findPlaceholders(draft).reduce((n, p) => n + p.count, 0);

/** The draft with every placeholder that has a value replaced. */
export function fillPlaceholders(draft: any, values: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [placeholderKey(k), String(v ?? "").trim()]).filter(([, v]) => v));
  if (!Object.keys(clean).length) return draft;
  return mapStrings(draft, (text) => replaceIn(text, clean));
}

/** Every text in the draft that still has a placeholder, with where it is. */
export function placeholderSpots(draft: any) {
  const spots: { path: Path; text: string }[] = [];
  for (const [path, text] of strings(draft)) if (placeholdersIn(text).length) spots.push({ path, text });
  return spots;
}

// Lists whose empty items can go (a table row keeps its empty cells so the columns stay in place).
const DROPPABLE = new Set(["paragraphs", "objectives", "key_points", "questions", "key_terms", "keywords"]);

/** Put rewritten texts back by path. A paragraph or list item rewritten to nothing is removed. */
export function applyTexts(draft: any, updates: [Path, string][]) {
  const copy = structuredClone(draft);
  const emptied = new Set<any>();
  for (const [path, text] of updates) {
    if (!path.length) continue;
    let parent = copy;
    for (const step of path.slice(0, -1)) {
      parent = parent?.[step];
      if (parent == null) break;
    }
    const last = path[path.length - 1];
    if (parent == null || typeof parent[last] !== "string") continue;
    parent[last] = String(text ?? "").trim();
    if (!parent[last] && Array.isArray(parent) && DROPPABLE.has(String(path[path.length - 2]))) emptied.add(parent);
  }
  for (const list of emptied) {
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] === "") list.splice(i, 1);
  }
  return copy;
}

const GUESSES: [RegExp, string][] = [
  [/^(the\s+)?(author|authors|author'?s?\s+(full\s+)?names?|your\s+(full\s+)?name|name\s+of\s+(the\s+)?authors?|writer'?s?\s+name|names?)$/i, "authors"],
  [/\b(institution|institute|university|affiliation|organi[sz]ation|department|college|hospital)\b/i, "affiliation"],
  [/\be-?mail\b/i, "email"],
];

/**
 * Values the author already gave for some placeholders. The server fills only the safe ones
 * (names, email); the editor also suggests the affiliation, for the author to check.
 */
export function guessValues(found: Found[], options: any, withAffiliation = false) {
  const values: Record<string, string> = {};
  for (const item of found) {
    for (const [pattern, field] of GUESSES) {
      if (field === "affiliation" && !withAffiliation) continue;
      const value = String(options?.[field] ?? "").trim();
      if (value && pattern.test(item.label.trim())) {
        values[item.key] = value;
        break;
      }
    }
  }
  return values;
}
