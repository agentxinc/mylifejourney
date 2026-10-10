// @ts-check
/**
 * One error contract for the Gemini-backed routes (/api/generate, /api/improve).
 *
 * Server: every failure returns `{ error: { code, message, field?, eventId? } }`.
 * The page picks user-facing copy from `code` and never shows provider text.
 * Client: responses that are not this JSON shape (e.g. a platform 504 HTML
 * page) are mapped by HTTP status.
 *
 * Plain ESM + JSDoc (no build step) so `node --test` can run the unit tests
 * without adding a test framework dependency.
 */

/** @typedef {"BUSY"|"TIMEOUT"|"BAD_INPUT"|"EMPTY"|"SERVER"|"OFFLINE"} ErrorCode */
/** @typedef {"title"|"date"} BadField */
/** @typedef {{ code: ErrorCode, field?: BadField, eventId?: string, retryAfterSec?: number }} ClientError */
/** @typedef {{ error: { code: ErrorCode, message: string, field?: string, eventId?: string } }} ApiErrorBody */
/** @typedef {{ status: number, body: ApiErrorBody, headers: Record<string, string> }} ErrorPayload */

/** Server stops waiting for Gemini after this long and returns TIMEOUT. */
export const SERVER_TIMEOUT_MS = 25_000;
/** Page gives up after this long (covers platform errors that never return). */
export const CLIENT_TIMEOUT_MS = 30_000;
/** Show "Still writing your story…" after this long. */
export const SLOW_HINT_MS = 10_000;
/** Countdown used for a repeated BUSY when the server gave no Retry-After. */
export const DEFAULT_BUSY_WAIT_SEC = 30;

/** @type {Record<ErrorCode, string>} */
export const GENERATE_ERROR_COPY = {
  BUSY: "We're at capacity right now — try again in a little while. Your entries are still here.",
  TIMEOUT: "This is taking longer than usual. Your entries are still here — give it another go.",
  BAD_INPUT: "Something in your entries needs a fix.",
  EMPTY: "We couldn't write your story this time. Try again, or add a little more detail to an entry.",
  SERVER: "Something went wrong on our side, not yours. Your entries are still here.",
  OFFLINE: "You seem to be offline. Your entries are still here — try again when you're connected.",
};

/** @type {Record<ErrorCode, string>} */
export const IMPROVE_ERROR_COPY = {
  ...GENERATE_ERROR_COPY,
  EMPTY: "We couldn't improve this one — your original is unchanged.",
};

/** BUSY copy while the button is counting down (replaces the BUSY line). */
export const BUSY_WAIT_COPY =
  "We're at capacity right now \u2014 you can try again in a moment. Your entries are still here.";

/** @type {Record<BadField, string>} */
export const FIELD_HINTS = {
  title: "Add a title for this moment.",
  date: "Add a date for this moment.",
};

/** @type {Record<ErrorCode, string>} */
const SERVER_MESSAGES = {
  BUSY: "The story service is at capacity.",
  TIMEOUT: "The story service took too long to respond.",
  BAD_INPUT: "The request is missing required information.",
  EMPTY: "The story service returned no usable story.",
  SERVER: "Story generation failed.",
  OFFLINE: "Network unavailable.",
};

/** @type {Record<Exclude<ErrorCode, "OFFLINE">, number>} */
export const STATUS_FOR_CODE = {
  BUSY: 503,
  TIMEOUT: 504,
  BAD_INPUT: 400,
  EMPTY: 502,
  SERVER: 500,
};

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

export class EmptyResultError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = "EmptyResultError";
  }
}

/**
 * Run `task(signal)` with a hard cutoff. When `ms` passes, the signal is
 * aborted (so the upstream HTTP call is cancelled and the function stops
 * waiting) and the returned promise rejects with TimeoutError.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} task
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(task, ms) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return Promise.race([
    task(controller.signal),
    /** @type {Promise<T>} */ (
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError());
        }, ms);
      })
    ),
  ]).finally(() => clearTimeout(timer));
}

/** True only for Gemini "model overloaded" (503 / UNAVAILABLE), never for quota (429). */
/** @param {unknown} err */
export function isOverloaded(err) {
  const e = /** @type {{ status?: unknown, code?: unknown, message?: unknown } | null} */ (err);
  const status = Number(e?.status ?? e?.code);
  const message = typeof e?.message === "string" ? e.message : "";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|\b429\b/i.test(message)) return false;
  return status === 503 || /UNAVAILABLE|overloaded|\b503\b/i.test(message);
}

/** Log line for a 503 retry (no user data). @param {string} route */
export const retryLog = (route) => () => console.warn(JSON.stringify({ route, retry: "gemini-503" }));

/** Base wait before the single 503 retry; jitter adds 0-500ms. */
export const RETRY_BASE_MS = 1_500;

/**
 * Run `task` once more if Gemini says it's overloaded (503). Never retries a
 * 429 or anything else, retries at most once, and gives up the moment `signal`
 * aborts, so the whole call stays inside withTimeout's budget.
 * @template T
 * @param {(signal: AbortSignal | undefined) => Promise<T>} task
 * @param {AbortSignal} [signal]
 * @param {{ baseMs?: number, random?: () => number, onRetry?: (err: unknown) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function retryOnOverload(task, signal, opts = {}) {
  try {
    return await task(signal);
  } catch (err) {
    if (!isOverloaded(err) || signal?.aborted) throw err;
    const wait = (opts.baseMs ?? RETRY_BASE_MS) + Math.floor((opts.random ?? Math.random)() * 500);
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(err)), { once: true });
    });
    opts.onRetry?.(err);
    return task(signal);
  }
}

/**
 * Map a thrown error (Gemini SDK, our own, anything) to a code.
 * @param {unknown} err
 * @returns {Exclude<ErrorCode, "OFFLINE"|"BAD_INPUT">}
 */
export function classifyError(err) {
  if (err instanceof TimeoutError) return "TIMEOUT";
  // Only a readable reply with no pages is EMPTY; unreadable replies are on us (SERVER).
  if (err instanceof EmptyResultError) return "EMPTY";
  const e = /** @type {{ status?: unknown, code?: unknown, message?: unknown, name?: unknown } | null} */ (err);
  const status = Number(e?.status ?? e?.code);
  const message = typeof e?.message === "string" ? e.message : "";
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|\b429\b/i.test(message)) return "BUSY";
  if (status === 503 || /UNAVAILABLE|overloaded|\b503\b/i.test(message)) return "BUSY";
  if (status === 504 || /DEADLINE_EXCEEDED|\b504\b/i.test(message) || e?.name === "AbortError") return "TIMEOUT";
  return "SERVER";
}

/**
 * Log code + provider status/code only; never the user's text or the raw message.
 * @param {string} route
 * @param {ErrorCode} code
 * @param {unknown} err
 */
export function logSafe(route, code, err) {
  const e = /** @type {{ status?: unknown, code?: unknown, name?: unknown, message?: unknown } | null} */ (err);
  const message = typeof e?.message === "string" ? e.message : "";
  const providerCode =
    message.match(/\b(RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND|INTERNAL)\b/)?.[1] ?? null;
  console.error(
    JSON.stringify({
      route,
      code,
      providerStatus: e?.status ?? e?.code ?? null,
      providerCode,
      errorName: e?.name ?? null,
    })
  );
}

/**
 * @param {Exclude<ErrorCode, "OFFLINE">} code
 * @param {{ field?: string, eventId?: string, retryAfterSec?: number }} [extra]
 * @returns {ErrorPayload}
 */
export function errorPayload(code, extra = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (extra.retryAfterSec) headers["Retry-After"] = String(extra.retryAfterSec);
  /** @type {ApiErrorBody} */
  const body = { error: { code, message: SERVER_MESSAGES[code] } };
  if (extra.field) body.error.field = extra.field;
  if (extra.eventId) body.error.eventId = extra.eventId;
  return { status: STATUS_FOR_CODE[code], body, headers };
}

/**
 * First missing title/date, as `events[i].field`; null when valid.
 * @param {unknown} events
 * @returns {{ field?: string, eventId?: string } | null}
 */
export function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return { field: "events" };
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const eventId = typeof ev?.id === "string" ? ev.id : undefined;
    if (typeof ev?.title !== "string" || !ev.title.trim()) return { field: `events[${i}].title`, eventId };
    if (typeof ev?.date !== "string" || !ev.date.trim()) return { field: `events[${i}].date`, eventId };
  }
  return null;
}

export const MOCK_VALUES = /** @type {const} */ (["busy", "timeout", "bad", "empty", "500", "html504", "slow"]);
/** @typedef {typeof MOCK_VALUES[number]} MockValue */

/**
 * Test-only `?mock=`; always null in Production.
 * @param {string} url
 * @param {string | undefined} vercelEnv
 * @returns {MockValue | null}
 */
export function getMock(url, vercelEnv) {
  if (vercelEnv === "production") return null;
  let value = null;
  try {
    value = new URL(url).searchParams.get("mock");
  } catch {
    return null;
  }
  return /** @type {readonly string[]} */ (MOCK_VALUES).includes(value ?? "")
    ? /** @type {MockValue} */ (value)
    : null;
}

/**
 * Build the mock response. "slow" waits 35s first (past the page's 30s cutoff).
 * `events` lets `bad` point at a real event on the page: the first one that is
 * really missing a title/date, else the first event's title.
 * @param {MockValue} mock
 * @param {{ sleep?: (ms: number) => Promise<void>, events?: unknown }} [opts]
 * @returns {Promise<Response>}
 */
export async function mockResponse(mock, opts = {}) {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** @param {ErrorPayload} p */
  const json = (p) =>
    new Response(JSON.stringify(p.body), {
      status: p.status,
      headers: { "Content-Type": "application/json", ...p.headers },
    });
  switch (mock) {
    case "busy": return json(errorPayload("BUSY", { retryAfterSec: 30 }));
    case "timeout": return json(errorPayload("TIMEOUT"));
    case "bad": {
      const list = Array.isArray(opts.events) ? opts.events : [];
      const real = list.length ? validateEvents(list) : null;
      const firstId = typeof list[0]?.id === "string" ? list[0].id : undefined;
      return json(errorPayload("BAD_INPUT", real ?? { field: "events[0].title", eventId: firstId }));
    }
    case "empty": return json(errorPayload("EMPTY"));
    case "500": return json(errorPayload("SERVER"));
    case "html504":
      return new Response(
        "<html><body>An error occurred with your deployment<br>FUNCTION_INVOCATION_TIMEOUT</body></html>",
        { status: 504, headers: { "Content-Type": "text/html" } }
      );
    case "slow":
      await sleep(35_000);
      return json(errorPayload("TIMEOUT"));
  }
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

/** @type {ErrorCode[]} */
const CODES = ["BUSY", "TIMEOUT", "BAD_INPUT", "EMPTY", "SERVER", "OFFLINE"];

/** @param {number} status @returns {ErrorCode} */
function codeFromStatus(status) {
  if (status === 429 || status === 503) return "BUSY";
  if (status === 504 || status === 408) return "TIMEOUT";
  if (status === 400 || status === 422) return "BAD_INPUT";
  return "SERVER";
}

/** @param {string | null} value */
function parseRetryAfter(value) {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 300) : undefined;
}

/**
 * Turn a non-OK response into a ClientError. Never throws.
 * @param {number} status
 * @param {string} bodyText
 * @param {string | null} retryAfterHeader
 * @returns {ClientError}
 */
export function parseErrorResponse(status, bodyText, retryAfterHeader) {
  /** @type {ClientError} */
  const out = { code: codeFromStatus(status) };
  const retryAfterSec = parseRetryAfter(retryAfterHeader);
  if (retryAfterSec) out.retryAfterSec = retryAfterSec;
  try {
    const err = JSON.parse(bodyText)?.error;
    if (err && typeof err === "object" && CODES.includes(err.code)) {
      out.code = err.code;
      const m = typeof err.field === "string" ? err.field.match(/\.(title|date)$/) : null;
      if (m) out.field = /** @type {BadField} */ (m[1]);
      if (typeof err.eventId === "string") out.eventId = err.eventId;
    }
  } catch {
    // Non-JSON body (platform error page): keep the status mapping.
  }
  return out;
}

/**
 * Map an exception thrown by fetch() itself.
 * @param {unknown} err
 * @param {boolean} timedOut  true when our own AbortController fired
 * @param {boolean} [online]  navigator.onLine
 * @returns {ClientError}
 */
export function classifyFetchFailure(err, timedOut, online = true) {
  if (timedOut) return { code: "TIMEOUT" };
  if (!online || err instanceof TypeError) return { code: "OFFLINE" };
  return { code: "SERVER" };
}

/** @param {unknown} data True when the response body is a usable story. */
export function isUsableStory(data) {
  const d = /** @type {{ pages?: unknown } | null} */ (data);
  return !!d && Array.isArray(d.pages) && d.pages.length > 0;
}
