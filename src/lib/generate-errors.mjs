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
export const SERVER_TIMEOUT_MS = 14_500;
/** Per-attempt cutoffs: primary model, then one lighter fallback model. */
export const PRIMARY_TIMEOUT_MS = 10_000;
export const FALLBACK_TIMEOUT_MS = 4_000;
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
          // Reject first so the race settles with TimeoutError, not the
          // task's own AbortError fired synchronously by abort().
          reject(new TimeoutError());
          controller.abort();
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
  // A numeric status is authoritative: only 503 is "overloaded".
  if (Number.isFinite(status) && status > 0) return status === 503;
  return /UNAVAILABLE|overloaded|\b503\b/i.test(message);
}

/**
 * Provider status/code of an error (no message, so no user data).
 * @param {unknown} err
 * @returns {{ status: unknown, code: string | null }}
 */
export function providerInfo(err) {
  if (err == null) return { status: null, code: null };
  const e = /** @type {{ status?: unknown, code?: unknown, message?: unknown }} */ (err);
  const message = typeof e?.message === "string" ? e.message : "";
  const code =
    message.match(/\b(RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND|INTERNAL)\b/)?.[1] ??
    (err instanceof TimeoutError ? "TIMEOUT" : null);
  return { status: e?.status ?? e?.code ?? null, code };
}

/**
 * Log line for a 503 retry (no user data). Called once the fallback attempt
 * has settled; primary and fallback provider status/code are separate fields.
 * @param {string} route
 * @returns {(primaryErr: unknown, fallbackErr?: unknown, info?: { answeredBy: string | null, attempts: unknown[] }) => void}
 */
export const retryLog = (route) => (primaryErr, fallbackErr, info) => {
  const p = providerInfo(primaryErr);
  const f = providerInfo(fallbackErr);
  console.warn(
    JSON.stringify({
      route,
      retry: info ? "provider-chain" : "gemini-fallback",
      primaryProviderStatus: p.status,
      primaryProviderCode: p.code,
      fallbackOk: fallbackErr == null,
      fallbackProviderStatus: f.status,
      fallbackProviderCode: f.code,
      // Custom order / Groq only: who answered (provider + model, never user text or keys).
      ...(info ? { answeredBy: info.answeredBy, attempts: info.attempts } : {}),
    })
  );
};

/** Base wait before the fallback attempt; jitter adds 0-200ms. */
export const RETRY_BASE_MS = 200;

/**
 * Wait `ms`, rejecting with `err` if `signal` aborts. The abort listener is
 * removed when the wait ends normally (no leak).
 * @param {number} ms @param {AbortSignal | undefined} signal @param {unknown} err
 */
export function abortableWait(ms, signal, err) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(err); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(undefined); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @param {AbortSignal | undefined} outer @param {AbortSignal} inner */
function linkSignals(outer, inner) {
  return outer ? AbortSignal.any([outer, inner]) : inner;
}

/** @returns {Error & { status: number }} */
function overloadedError() {
  return Object.assign(new Error("UNAVAILABLE: primary and fallback models overloaded"), { status: 503 });
}

/** Groq step cutoff (MLJ_GROQ_TIMEOUT_MS). */
export const GROQ_TIMEOUT_MS = 4_000;
/** Chain stops this far before SERVER_TIMEOUT_MS so our BUSY beats the route's TIMEOUT. */
export const CHAIN_MARGIN_MS = 100;
/** A step is skipped (not started) when less than this much budget is left. */
export const MIN_STEP_MS = 1_000;

/** @typedef {"gemini-primary"|"gemini-lite"|"groq"} ProviderId */
export const PROVIDER_IDS = /** @type {const} */ (["gemini-primary", "gemini-lite", "groq"]);
export const DEFAULT_PROVIDER_ORDER = "gemini-primary,gemini-lite";
/** Order used when MLJ_FALLBACK_PROVIDER=groq and MLJ_PROVIDER_ORDER is unset. */
export const GROQ_FALLBACK_ORDER = "gemini-primary,gemini-lite,groq";

/** @param {unknown} v @param {number} dflt */
function envMs(v, dflt) {
  const n = Number(typeof v === "string" ? v.trim() : v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * Read the provider chain config from env. Groq is only ever in the chain when
 * MLJ_FALLBACK_PROVIDER=groq AND GROQ_API_KEY is set; otherwise behavior is
 * exactly the pre-Groq default. Every step timeout is clamped to the hard cap.
 * Never returns or logs the key itself.
 * @param {Record<string, string | undefined>} env
 */
export function chainConfigFromEnv(env) {
  const groqEnabled = env.MLJ_FALLBACK_PROVIDER?.trim().toLowerCase() === "groq" && !!env.GROQ_API_KEY?.trim();
  const raw = env.MLJ_PROVIDER_ORDER?.trim() || (groqEnabled ? GROQ_FALLBACK_ORDER : DEFAULT_PROVIDER_ORDER);
  /** @type {ProviderId[]} */
  const order = [];
  for (const id of raw.split(",").map((x) => x.trim().toLowerCase())) {
    if (!(/** @type {readonly string[]} */ (PROVIDER_IDS)).includes(id)) continue;
    if (id === "groq" && !groqEnabled) continue;
    if (!order.includes(/** @type {ProviderId} */ (id))) order.push(/** @type {ProviderId} */ (id));
  }
  if (!order.length) order.push("gemini-primary", "gemini-lite");
  return {
    order,
    groqEnabled,
    stepMs: {
      "gemini-primary": Math.min(envMs(env.MLJ_PRIMARY_TIMEOUT_MS, PRIMARY_TIMEOUT_MS), SERVER_TIMEOUT_MS),
      "gemini-lite": Math.min(envMs(env.MLJ_FALLBACK_TIMEOUT_MS, FALLBACK_TIMEOUT_MS), SERVER_TIMEOUT_MS),
      groq: Math.min(envMs(env.MLJ_GROQ_TIMEOUT_MS, GROQ_TIMEOUT_MS), SERVER_TIMEOUT_MS),
    },
  };
}

/** @param {unknown} err  Groq 429/5xx are capacity errors: no retry, move on / BUSY. */
function isCapacity(err) {
  const s = Number(/** @type {{ status?: unknown }} */ (err)?.status);
  return isOverloaded(err) || s === 429 || (s >= 500 && s <= 599);
}

/**
 * Run providers in order, each once, each with its own cutoff clamped to the
 * remaining hard-cap budget (total never exceeds min(capMs, SERVER_TIMEOUT_MS)
 * - CHAIN_MARGIN_MS, whatever env says). Moves to the next provider only on an
 * overload/timeout (Gemini 503, Groq 429/5xx); a Gemini 429 or any other error
 * is thrown as-is. Nothing is ever retried on the same provider. If every
 * provider that ran was overloaded/timed out, or the budget ran out, throws a
 * 503-shaped error so the route answers BUSY.
 *
 * Default (no order/groq opts) is exactly the old behavior: primary 10s, pause
 * 200-400ms, fallback 4s. In Gemini-first order Groq only realistically helps
 * after a FAST 503: 10s + pause + 4s leaves ~0.3s, under MIN_STEP_MS, so Groq
 * is skipped after a primary timeout.
 * @template T
 * @param {(which: "primary" | "fallback", signal: AbortSignal) => Promise<T>} task  Gemini call
 * @param {AbortSignal} [signal]  outer hard-cap signal (from withTimeout)
 * @param {{ primaryMs?: number, fallbackMs?: number, groqMs?: number, capMs?: number, minStepMs?: number,
 *   order?: ProviderId[], models?: Partial<Record<ProviderId, string>>, groq?: (signal: AbortSignal) => Promise<T>, now?: () => number,
 *   baseMs?: number, random?: () => number,
 *   onRetry?: (primaryErr: unknown, fallbackErr?: unknown, info?: { answeredBy: string | null, attempts: { provider: string, status: unknown, code: unknown }[] }) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withModelFallback(task, signal, opts = {}) {
  const now = opts.now ?? Date.now;
  const deadline = now() + Math.min(opts.capMs ?? SERVER_TIMEOUT_MS, SERVER_TIMEOUT_MS) - CHAIN_MARGIN_MS;
  const minStep = opts.minStepMs ?? MIN_STEP_MS;
  const custom = !!opts.order;
  /** @type {ProviderId[]} */
  const order = (opts.order ?? ["gemini-primary", "gemini-lite"]).filter((id) => id !== "groq" || !!opts.groq);
  /** @type {Record<ProviderId, number>} */
  const stepMs = {
    "gemini-primary": opts.primaryMs ?? PRIMARY_TIMEOUT_MS,
    "gemini-lite": opts.fallbackMs ?? FALLBACK_TIMEOUT_MS,
    groq: opts.groqMs ?? GROQ_TIMEOUT_MS,
  };
  /** @type {{ provider: string, err: unknown }[]} */
  const tried = [];
  const report = (/** @type {string | null} */ answeredBy) => {
    if (!tried.length || (!answeredBy && tried.length < 2 && !custom)) return;
    const first = tried[0].err;
    const last = tried.length > 1 ? tried[tried.length - 1].err : undefined;
    opts.onRetry?.(first, answeredBy ? undefined : last ?? first,
      custom ? { answeredBy, attempts: tried.map((t) => ({ provider: t.provider, ...providerInfo(t.err) })) } : undefined);
  };
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (i > 0) {
      const wait = (opts.baseMs ?? RETRY_BASE_MS) + Math.floor((opts.random ?? Math.random)() * 200);
      await abortableWait(Math.max(0, Math.min(wait, deadline - now())), signal, tried[tried.length - 1].err);
    }
    const remaining = deadline - now();
    if (remaining < Math.min(minStep, stepMs[id])) break; // budget exhausted: skip the rest
    const ms = Math.min(stepMs[id], remaining);
    try {
      const run = (/** @type {AbortSignal} */ s) => {
        const sig = linkSignals(signal, s);
        if (id === "groq") return /** @type {NonNullable<typeof opts.groq>} */ (opts.groq)(sig);
        return task(id === "gemini-primary" ? "primary" : "fallback", sig);
      };
      const result = await withTimeout(run, ms);
      if (tried.length) report(opts.models?.[id] ? `${id}:${opts.models[id]}` : id);
      return result;
    } catch (err) {
      tried.push({ provider: id, err });
      const movable = id === "groq" ? isCapacity(err) || err instanceof TimeoutError : isOverloaded(err) || err instanceof TimeoutError;
      if (!movable || signal?.aborted) {
        if (tried.length > 1) report(null);
        throw err;
      }
    }
  }
  report(null);
  // Classic single-provider order keeps its old contract: a lone failure is rethrown.
  if (tried.length === 1 && order.length === 1) throw tried[0].err;
  throw overloadedError();
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

/** Max chars of provider message we ever log. */
export const LOG_MESSAGE_MAX = 300;

/**
 * Log code + provider status/code. The provider message (truncated) is logged
 * only for 503/429/UNAVAILABLE/RESOURCE_EXHAUSTED, never for INVALID_ARGUMENT
 * or anything else, and never if it contains any of `userTexts`.
 * @param {string} route
 * @param {ErrorCode} code
 * @param {unknown} err
 * @param {{ userTexts?: string[] }} [opts]
 */
export function logSafe(route, code, err, opts = {}) {
  const e = /** @type {{ status?: unknown, code?: unknown, name?: unknown, message?: unknown } | null} */ (err);
  const message = typeof e?.message === "string" ? e.message : "";
  const providerCode =
    message.match(/\b(RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND|INTERNAL)\b/)?.[1] ?? null;
  const status = Number(e?.status ?? e?.code);
  const capacity =
    providerCode !== "INVALID_ARGUMENT" &&
    (status === 503 || status === 429 || providerCode === "UNAVAILABLE" || providerCode === "RESOURCE_EXHAUSTED");
  const texts = (opts.userTexts ?? []).filter((t) => typeof t === "string" && t.trim().length >= 3);
  const leaks = texts.some((t) => message.toLowerCase().includes(t.trim().toLowerCase()));
  console.error(
    JSON.stringify({
      route,
      code,
      providerStatus: e?.status ?? e?.code ?? null,
      providerCode,
      errorName: e?.name ?? null,
      ...(capacity && !leaks && message ? { providerMessage: message.slice(0, LOG_MESSAGE_MAX) } : {}),
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


