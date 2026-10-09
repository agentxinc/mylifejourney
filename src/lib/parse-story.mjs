// @ts-check
import { EmptyResultError } from "./generate-errors.mjs";

/**
 * Gemini sent something we can't read (empty, not JSON, stopped early, or
 * blocked). Not the user's fault, so classifyError maps it to SERVER, not EMPTY.
 */
export class BadReplyError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = "BadReplyError";
  }
}

/**
 * Parse Gemini's story JSON, tolerating shapes models return: ```json fences,
 * prose around the object, the story nested under one key, "chapters" instead
 * of "pages", and a bare pages array.
 * Throws BadReplyError for an empty/unreadable reply, and EmptyResultError
 * only for a readable reply that has no usable pages.
 * @param {string} text
 * @returns {{ title?: string, subtitle?: string, pages: any[] }}
 */
export function parseStoryText(text) {
  const raw = (text ?? "").trim();
  if (!raw) throw new BadReplyError("empty response");
  // A real story is far smaller (output is capped at 16k tokens); refuse huge
  // replies before any parsing so junk can't cost seconds of CPU.
  if (raw.length > MAX_REPLY_CHARS) throw new BadReplyError("reply too large");
  const value = parseLoose(raw);
  // Keep the parse only on failure (for the shape log); a good story is never held.
  lastParse = { raw, value };
  const story = value === undefined ? null : findStory(value);
  if (story) {
    lastParse = EMPTY_PARSE;
    return story;
  }
  if (value === undefined) throw new BadReplyError("invalid JSON");
  throw new EmptyResultError("no pages");
}

/**
 * Upper bound on a reply we will try to parse: about 2x what the 16k-token
 * output cap can produce (~4-5 chars/token of JSON), so a real story is never
 * refused. With a single parse, the worst case (deeply nested JSON just
 * under the limit) stays around half a second.
 */
export const MAX_REPLY_CHARS = 128_000;

/** The last parse, so the shape log after a failure doesn't parse again. */
const EMPTY_PARSE = { raw: "", value: /** @type {unknown} */ (undefined) };
let lastParse = EMPTY_PARSE;

const MAX_STARTS = 20;
const MAX_ENDS = 20;

/**
 * Start positions for `open`, most JSON-like first: `{"` / `[{` style starts
 * before bare braces, so prose like "{smile}" doesn't use up the tries.
 * @param {string} s @param {string} open
 */
function starts(s, open) {
  const strong = [];
  const weak = [];
  for (let i = s.indexOf(open); i >= 0 && strong.length < MAX_STARTS; i = s.indexOf(open, i + 1)) {
    const next = s.slice(i + 1, i + 40).trimStart()[0];
    if (open === "{" ? next === '"' : next === "{" || next === "[") strong.push(i);
    else if (weak.length < MAX_STARTS) weak.push(i);
  }
  return [...strong, ...weak].slice(0, MAX_STARTS);
}

/**
 * End positions for `close`, last first, so "{smile}" after the JSON can't
 * pin the end past the real object.
 * @param {string} s @param {string} close
 */
function ends(s, close) {
  const out = [];
  for (let i = s.lastIndexOf(close); i >= 0 && out.length < MAX_ENDS; i = s.lastIndexOf(close, i - 1)) out.push(i);
  return out;
}

/**
 * Whole text, then a fenced block, then objects (then arrays) between likely
 * start and end positions. Bounded to MAX_STARTS x MAX_ENDS parses per kind.
 * @param {string} raw
 */
function parseLoose(raw) {
  const tryParse = (/** @type {string} */ c) => {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      return { ok: false, value: undefined };
    }
  };
  let r = tryParse(raw);
  if (r.ok) return r.value;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    r = tryParse(fenced[1].trim());
    if (r.ok) return r.value;
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const endList = ends(raw, close);
    for (const start of starts(raw, open)) {
      for (const end of endList) {
        if (end <= start) break;
        r = tryParse(raw.slice(start, end + 1));
        if (r.ok) return r.value;
      }
    }
  }
  return undefined;
}

/** @param {any} p A page needs to be an object with a title or narrative. */
const isPage = (p) =>
  !!p &&
  typeof p === "object" &&
  !Array.isArray(p) &&
  ((typeof p.narrative === "string" && p.narrative.trim() !== "") ||
    (typeof p.title === "string" && p.title.trim() !== ""));

/** @param {unknown} v @returns {v is any[]} */
const pageList = (v) => Array.isArray(v) && v.length > 0 && v.every(isPage);

/**
 * @param {any} value
 * @param {number} [depth]
 * @returns {{ title?: string, subtitle?: string, pages: any[] } | null}
 */
function findStory(value, depth = 0) {
  if (depth > 2 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] && typeof value[0] === "object" && !isPage(value[0])) {
      return findStory(value[0], depth + 1); // [{ title, pages }]
    }
    if (value.length === 1 && pageList(value[0]?.pages)) return findStory(value[0], depth + 1);
    return pageList(value) ? { pages: numbered(value) } : null;
  }
  const pages = pageList(value.pages) ? value.pages : pageList(value.chapters) ? value.chapters : null;
  if (pages) {
    return {
      title: typeof value.title === "string" ? value.title : undefined,
      subtitle: typeof value.subtitle === "string" ? value.subtitle : undefined,
      pages: numbered(pages),
    };
  }
  for (const key of Object.keys(value)) {
    const found = findStory(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** @param {any[]} pages */
function numbered(pages) {
  return pages.map((p, i) => ({ ...p, pageNumber: typeof p.pageNumber === "number" ? p.pageNumber : i + 1 }));
}

/**
 * Shape-only description for logs. Never includes text or model-chosen key
 * names (those could echo user text); only known keys as booleans plus counts.
 * @param {string} text
 * @param {{ finishReason?: unknown, blockReason?: unknown }} [meta]
 */
export function describeResponse(text, meta = {}) {
  const raw = (text ?? "").trim();
  const v =
    !raw || raw.length > MAX_REPLY_CHARS ? undefined : raw === lastParse.raw ? lastParse.value : parseLoose(raw);
  lastParse = EMPTY_PARSE; // don't keep user text in memory after logging
  const isObj = !!v && typeof v === "object" && !Array.isArray(v);
  const first = raw.slice(0, 1);
  return {
    finishReason: meta.finishReason ?? null,
    blockReason: meta.blockReason ?? null,
    textLength: raw.length,
    firstChar: /^[{\[`"]$/.test(first) ? first : first ? "other" : null,
    fenced: raw.includes("```"),
    parsed: v === undefined ? false : Array.isArray(v) ? "array" : typeof v,
    keyCount: isObj ? Object.keys(v).length : null,
    hasTitle: isObj ? "title" in v : null,
    hasPages: isObj ? "pages" in v : null,
    pagesLength: isObj && Array.isArray(v.pages) ? v.pages.length : null,
    hasChapters: isObj ? "chapters" in v : null,
  };
}
