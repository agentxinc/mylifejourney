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
  const value = parseLoose(raw);
  if (value === undefined) throw new BadReplyError("invalid JSON");
  const story = findStory(value);
  if (!story) throw new EmptyResultError("no pages");
  return story;
}

const MAX_TRIES = 20;

/**
 * Whole text, then a fenced block, then objects starting at each "{" (so prose
 * like "{smile}" before the JSON doesn't hide it), then arrays.
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
    const end = raw.lastIndexOf(close);
    let start = raw.indexOf(open);
    for (let n = 0; start >= 0 && start < end && n < MAX_TRIES; n++) {
      r = tryParse(raw.slice(start, end + 1));
      if (r.ok) return r.value;
      start = raw.indexOf(open, start + 1);
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
  const v = raw ? parseLoose(raw) : undefined;
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
