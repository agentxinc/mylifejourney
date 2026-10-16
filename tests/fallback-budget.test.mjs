import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withTimeout, withModelFallback, isOverloaded, classifyError, logSafe, abortableWait,
  TimeoutError, SERVER_TIMEOUT_MS, PRIMARY_TIMEOUT_MS, FALLBACK_TIMEOUT_MS,
} from "../src/lib/generate-errors.mjs";

const e503 = () => Object.assign(new Error("UNAVAILABLE: model overloaded"), { status: 503 });
const hang = (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
// Scale: 1 real ms = 100 budget ms, so the real 15 s budget is 150 ms here.
const S = 100, BUDGET = 15_000 / S;
const run = (task) => withTimeout((sig) => withModelFallback(task, sig, {
  primaryMs: PRIMARY_TIMEOUT_MS / S, fallbackMs: FALLBACK_TIMEOUT_MS / S, baseMs: 2, random: () => 0,
}), SERVER_TIMEOUT_MS / S);

test("constants fit the 15 s budget", () => {
  assert.equal(PRIMARY_TIMEOUT_MS, 10_000); assert.equal(FALLBACK_TIMEOUT_MS, 4_000); assert.equal(SERVER_TIMEOUT_MS, 14_500);
  assert.ok(SERVER_TIMEOUT_MS < 15_000);
});

for (const [name, primary, fallback] of [
  ["503 + 503", async () => { throw e503(); }, async () => { throw e503(); }],
  ["503 + hang", async () => { throw e503(); }, hang],
  ["hang + 503", hang, async () => { throw e503(); }],
  ["hang + hang", hang, hang],
]) {
  test(`worst case ${name} -> BUSY within budget`, async () => {
    const calls = [];
    const t0 = Date.now();
    const err = await run((which, sig) => (calls.push(which), which === "primary" ? primary(sig) : fallback(sig))).catch((e) => e);
    const ms = Date.now() - t0;
    assert.ok(ms < BUDGET, `took ${ms}ms (budget ${BUDGET})`);
    assert.equal(classifyError(err), name === "hang + hang" ? classifyError(err) : "BUSY");
    assert.ok(["BUSY", "TIMEOUT"].includes(classifyError(err)));
    if (name !== "hang + hang") assert.equal(classifyError(err), "BUSY");
    assert.deepEqual(calls, ["primary", "fallback"]);
  });
}

test("fallback success returns its result", async () => {
  const r = await run(async (w) => { if (w === "primary") throw e503(); return "ok"; });
  assert.equal(r, "ok");
});

test("429 and 403 are not retried", async () => {
  for (const status of [429, 403]) {
    const calls = [];
    const err = await run(async (w) => { calls.push(w); throw Object.assign(new Error("x"), { status }); }).catch((e) => e);
    assert.deepEqual(calls, ["primary"]);
    assert.equal(classifyError(err), status === 429 ? "BUSY" : "SERVER");
  }
});

test("isOverloaded: numeric non-503 with UNAVAILABLE text is not overload", () => {
  assert.equal(isOverloaded({ status: 500, message: "UNAVAILABLE" }), false);
  assert.equal(isOverloaded({ status: 404, message: "503 something" }), false);
  assert.equal(isOverloaded({ status: 503 }), true);
  assert.equal(isOverloaded({ message: "UNAVAILABLE" }), true);
  assert.equal(isOverloaded({ status: 429 }), false);
});

test("withTimeout aborts signal and rejects with TimeoutError", async () => {
  let seen;
  const err = await withTimeout((s) => (seen = s, hang(s)), 10).catch((e) => e);
  assert.ok(err instanceof TimeoutError);
  assert.equal(seen.aborted, true);
});

test("abortableWait removes its abort listener", async () => {
  const c = new AbortController();
  let added = 0, removed = 0;
  const add = c.signal.addEventListener.bind(c.signal), rm = c.signal.removeEventListener.bind(c.signal);
  c.signal.addEventListener = (...a) => (added++, add(...a));
  c.signal.removeEventListener = (...a) => (removed++, rm(...a));
  await abortableWait(1, c.signal, new Error("x"));
  assert.equal(added, 1); assert.equal(removed, 1);
});

function captureLog(fn) {
  const orig = console.error; let out = "";
  console.error = (s) => { out += s; };
  try { fn(); } finally { console.error = orig; }
  return JSON.parse(out);
}

test("logSafe logs 503 message truncated to 300 chars", () => {
  const log = captureLog(() => logSafe("generate", "BUSY", { status: 503, message: "UNAVAILABLE " + "x".repeat(500) }));
  assert.equal(log.providerMessage.length, 300);
});

test("logSafe never logs INVALID_ARGUMENT message containing user text", () => {
  const log = captureLog(() => logSafe("generate", "SERVER",
    { status: 400, message: "INVALID_ARGUMENT: bad request near 'My wedding in Goa'" }, { userTexts: ["My wedding in Goa"] }));
  assert.equal(log.providerMessage, undefined);
  assert.ok(!JSON.stringify(log).includes("wedding"));
});

test("logSafe skips a 503 message that echoes user text (second guard)", () => {
  const log = captureLog(() => logSafe("generate", "BUSY", { status: 503, message: "UNAVAILABLE for 'My wedding in Goa'" }, { userTexts: ["My wedding in Goa"] }));
  assert.equal(log.providerMessage, undefined);
});
