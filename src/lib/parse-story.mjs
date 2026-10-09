// @ts-check
import { EmptyResultError } from "./generate-errors.mjs";

/**
 * Parse Gemini's story JSON, tolerating the shapes models actually return:
 * ```json fences, prose around the object, a top-level pages array, the story
 * nested under one key ({ story: {...} }), and "chapters" instead of "pages".
 * Throws EmptyResultError(reason) only when there is truly no usable story.
 * @param {string} text
 * @returns {{ title?: string, subtitle?: string, pages: any[] }}
 */
export function parseStoryText(text) {
  const raw = (text ?? "").trim();
  if (!raw) throw new EmptyResultError("empty response");
  const value = parseLoose(raw);
  if (value === undefined) throw new EmptyResultError("invalid JSON");
  const story = findStory(value);
  if (!story) throw new EmptyResultError("no pages");
  return story;
}

/** @param {string} raw */
function parseLoose(raw) {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const obj = sliceBetween(raw, "{", "}");
  if (obj) candidates.push(obj);
  const arr = sliceBetween(raw, "[", "]");
  if (arr) candidates.push(arr);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/** @param {string} s @param {string} open @param {string} close */
function sliceBetween(s, open, close) {
  const a = s.indexOf(open);
  const b = s.lastIndexOf(close);
  return a >= 0 && b > a ? s.slice(a, b + 1) : null;
}

/** @param {unknown} v @returns {v is any[]} */
const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0;

/**
 * @param {any} value
 * @param {number} [depth]
 * @returns {{ title?: string, subtitle?: string, pages: any[] } | null}
 */
function findStory(value, depth = 0) {
  if (nonEmptyArray(value)) {
    if (value.every((p) => p && typeof p === "object")) {
      // Either a bare pages array, or [{ title, pages }].
      if (value.length === 1 && nonEmptyArray(value[0]?.pages)) return findStory(value[0], depth + 1);
      return { pages: numbered(value) };
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const pages = nonEmptyArray(value.pages) ? value.pages : nonEmptyArray(value.chapters) ? value.chapters : null;
  if (pages) {
    return {
      title: typeof value.title === "string" ? value.title : undefined,
      subtitle: typeof value.subtitle === "string" ? value.subtitle : undefined,
      pages: numbered(pages),
    };
  }
  if (depth < 2) {
    for (const key of Object.keys(value)) {
      const found = findStory(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** @param {any[]} pages */
function numbered(pages) {
  return pages.map((p, i) => ({ ...p, pageNumber: typeof p.pageNumber === "number" ? p.pageNumber : i + 1 }));
}

/**
 * Shape-only description for logs (no user or story text).
 * @param {string} text
 * @param {unknown} [finishReason]
 */
export function describeResponse(text, finishReason) {
  const raw = (text ?? "").trim();
  let topKeys = null;
  const v = raw ? parseLoose(raw) : undefined;
  if (v && typeof v === "object") topKeys = Array.isArray(v) ? ["<array>"] : Object.keys(v).slice(0, 10);
  return {
    finishReason: finishReason ?? null,
    textLength: raw.length,
    fenced: /```/.test(raw),
    startsWith: raw.slice(0, 1) || null,
    topKeys,
  };
}
