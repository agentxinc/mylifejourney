import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  withTimeout, withModelFallback, chainConfigFromEnv, classifyError, retryLog, logSafe, resetConfigWarnings,
  SERVER_TIMEOUT_MS, PRIMARY_TIMEOUT_MS, FALLBACK_TIMEOUT_MS, GROQ_TIMEOUT_MS,
} from "../src/lib/generate-errors.mjs";
import { groqGenerate, GROQ_URL, DEFAULT_GROQ_MODEL } from "../src/lib/groq.mjs";

const KEY = "gsk_test_secret_key_123";
const USER_TEXT = "My wedding in Goa";
const e503 = () => Object.assign(new Error("UNAVAILABLE: model overloaded"), { status: 503 });
const hang = (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
const okBody = { choices: [{ finish_reason: "stop", message: { content: '{"title":"t","pages":[{"title":"p"}]}' } }] };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Mocked fetch: records calls, never touches the network. */
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(init); };
  return { f, calls };
}

/**
 * Run the chain the way the routes do (route-level withTimeout at 14.5s +
 * env-driven chain), under fake timers. Returns result/error, virtual ms, calls.
 */
async function runChain(env, { gemini, groqFetch, logs } = {}) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const cfg = chainConfigFromEnv(env);
    const geminiCalls = [];
    const g = groqFetch ?? fakeFetch(() => jsonRes(200, okBody));
    const t0 = Date.now();
    const p = withTimeout((signal) => withModelFallback(
      (which, sig) => (geminiCalls.push(which), gemini[which](sig)),
      signal,
      {
        ...(cfg.groqEnabled || env.MLJ_PROVIDER_ORDER ? { order: cfg.order } : {}),
        primaryMs: cfg.stepMs["gemini-primary"], fallbackMs: cfg.stepMs["gemini-lite"], groqMs: cfg.stepMs.groq,
        models: { groq: env.MLJ_GROQ_MODEL || DEFAULT_GROQ_MODEL },
        groq: (sig) => groqGenerate(`story about ${USER_TEXT}`, sig, { env, fetch: g.f }).then((r) => r.text),
        random: () => 0,
        onRetry: (a, b, c) => logs?.push(JSON.stringify({ a: String(a?.message), c })) ?? retryLog("generate")(a, b, c),
      }
    ), SERVER_TIMEOUT_MS);
    let out, err, done = false;
    p.then((r) => { out = r; }, (e) => { err = e; }).finally(() => { done = true; });
    for (let i = 0; i < 2000 && !done; i++) {
      await new Promise((r) => setImmediate(r));
      if (!done) mock.timers.tick(50);
    }
    assert.ok(done, "chain settled");
    return { out, err, ms: Date.now() - t0, geminiCalls, groqCalls: g.calls };
  } finally {
    mock.timers.reset();
  }
}

const ON = { MLJ_FALLBACK_PROVIDER: "groq", GROQ_API_KEY: KEY };
const both503 = { primary: async () => { throw e503(); }, fallback: async () => { throw e503(); } };

test("config: default order unchanged; Groq needs flag AND key; timeouts clamped to 14.5s", () => {
  assert.deepEqual(chainConfigFromEnv({}).order, ["gemini-primary", "gemini-lite"]);
  assert.equal(chainConfigFromEnv({}).groqEnabled, false);
  assert.deepEqual(chainConfigFromEnv({ MLJ_FALLBACK_PROVIDER: "groq" }).order, ["gemini-primary", "gemini-lite"]);
  assert.deepEqual(chainConfigFromEnv({ GROQ_API_KEY: KEY, MLJ_PROVIDER_ORDER: "groq,gemini-primary" }).order, ["gemini-primary"]);
  assert.deepEqual(chainConfigFromEnv(ON).order, ["gemini-primary", "gemini-lite", "groq"]);
  assert.deepEqual(chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: "groq,gemini-primary" }).order, ["groq", "gemini-primary"]);
  const d = chainConfigFromEnv({}).stepMs;
  assert.deepEqual(d, { "gemini-primary": PRIMARY_TIMEOUT_MS, "gemini-lite": FALLBACK_TIMEOUT_MS, groq: GROQ_TIMEOUT_MS });
  const big = chainConfigFromEnv({ MLJ_PRIMARY_TIMEOUT_MS: "60000", MLJ_FALLBACK_TIMEOUT_MS: "60000", MLJ_GROQ_TIMEOUT_MS: "60000" }).stepMs;
  assert.ok(Object.values(big).every((v) => v <= SERVER_TIMEOUT_MS));
  assert.ok(!JSON.stringify(chainConfigFromEnv(ON)).includes(KEY), "config never carries the key");
});

test("flag off: no Groq call (default behavior, BUSY after both Gemini 503)", async () => {
  const g = fakeFetch(() => jsonRes(200, okBody));
  const r = await runChain({ GROQ_API_KEY: KEY }, { gemini: both503, groqFetch: g, logs: [] });
  assert.equal(g.calls.length, 0);
  assert.deepEqual(r.geminiCalls, ["primary", "fallback"]);
  assert.equal(classifyError(r.err), "BUSY");
});

test("flag on without key: no Groq call", async () => {
  const g = fakeFetch(() => jsonRes(200, okBody));
  const r = await runChain({ MLJ_FALLBACK_PROVIDER: "groq" }, { gemini: both503, groqFetch: g, logs: [] });
  assert.equal(g.calls.length, 0);
  assert.equal(classifyError(r.err), "BUSY");
});

test("fast 503 on both Gemini -> Groq answers; request shape, model, key only in header", async () => {
  const logs = [];
  const r = await runChain(ON, { gemini: both503, logs });
  assert.ok(r.out.includes('"pages"'));
  assert.equal(r.groqCalls.length, 1);
  const { url, init } = r.groqCalls[0];
  assert.equal(url, GROQ_URL);
  assert.equal(JSON.parse(init.body).model, "openai/gpt-oss-120b");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(logs.length, 1, "single fallback log line");
  const info = JSON.parse(logs[0]).c;
  assert.equal(info.answeredBy, "groq:openai/gpt-oss-120b");
  assert.ok(r.ms <= SERVER_TIMEOUT_MS);
});

test("MLJ_GROQ_MODEL overrides the model", async () => {
  const r = await runChain({ ...ON, MLJ_GROQ_MODEL: "qwen/qwen3.8-27b" }, { gemini: both503, logs: [] });
  assert.equal(JSON.parse(r.groqCalls[0].init.body).model, "qwen/qwen3.8-27b");
});

for (const status of [429, 500, 503]) {
  test(`Groq ${status} -> BUSY with exactly 1 Groq call (no retry)`, async () => {
    const g = fakeFetch(() => jsonRes(status, { error: { message: `over capacity ${USER_TEXT}` } }));
    const r = await runChain(ON, { gemini: both503, groqFetch: g, logs: [] });
    assert.equal(g.calls.length, 1);
    assert.equal(classifyError(r.err), "BUSY");
    assert.ok(r.ms <= SERVER_TIMEOUT_MS);
  });
}

test("Groq timeout -> BUSY within the 14.5s cap", async () => {
  const g = fakeFetch((init) => hang(init.signal));
  const r = await runChain(ON, { gemini: both503, groqFetch: g, logs: [] });
  assert.equal(g.calls.length, 1);
  assert.equal(classifyError(r.err), "BUSY");
  assert.ok(r.ms <= SERVER_TIMEOUT_MS, `took ${r.ms}`);
  assert.ok(r.ms >= GROQ_TIMEOUT_MS, "Groq got its own cutoff");
});

test("budget exhausted (primary timeout + lite timeout) -> Groq skipped, BUSY", async () => {
  const g = fakeFetch(() => jsonRes(200, okBody));
  const r = await runChain(ON, { gemini: { primary: hang, fallback: hang }, groqFetch: g, logs: [] });
  assert.equal(g.calls.length, 0, "only ~0.3s left, under MIN_STEP_MS");
  assert.equal(classifyError(r.err), "BUSY");
  assert.ok(r.ms <= SERVER_TIMEOUT_MS);
});

test("oversized env timeouts (60000 each) + hanging mocks -> BUSY at <= 14.5s", async () => {
  for (const order of [undefined, "gemini-primary,gemini-lite,groq", "groq,gemini-primary"]) {
    const env = { ...ON, MLJ_PRIMARY_TIMEOUT_MS: "60000", MLJ_FALLBACK_TIMEOUT_MS: "60000", MLJ_GROQ_TIMEOUT_MS: "60000",
      ...(order ? { MLJ_PROVIDER_ORDER: order } : {}) };
    const g = fakeFetch((init) => hang(init.signal));
    const r = await runChain(env, { gemini: { primary: hang, fallback: hang }, groqFetch: g, logs: [] });
    assert.equal(classifyError(r.err), "BUSY", `order ${order}`);
    assert.ok(r.ms <= SERVER_TIMEOUT_MS, `order ${order} took ${r.ms}`);
  }
});

test("total <= 14.5s on every forced path (all orders x all failure kinds)", async () => {
  const kinds = { "503": async () => { throw e503(); }, hang };
  const gKinds = { "429": () => jsonRes(429, {}), "500": () => jsonRes(500, {}), hang: (i) => hang(i.signal) };
  for (const order of ["gemini-primary,gemini-lite", "gemini-primary,gemini-lite,groq", "groq,gemini-primary", "groq,gemini-primary,gemini-lite"]) {
    for (const [pk, p] of Object.entries(kinds)) for (const [fk, f] of Object.entries(kinds)) for (const [gk, gh] of Object.entries(gKinds)) {
      const r = await runChain({ ...ON, MLJ_PROVIDER_ORDER: order }, { gemini: { primary: p, fallback: f }, groqFetch: fakeFetch(gh), logs: [] });
      assert.ok(r.ms <= SERVER_TIMEOUT_MS, `${order} ${pk}/${fk}/${gk} took ${r.ms}`);
      assert.equal(classifyError(r.err), "BUSY", `${order} ${pk}/${fk}/${gk}`);
      assert.ok(r.groqCalls.length <= 1);
    }
  }
});

test("Groq-primary order: Groq answers first, Gemini not called", async () => {
  const r = await runChain({ ...ON, MLJ_PROVIDER_ORDER: "groq,gemini-primary" }, { gemini: both503, logs: [] });
  assert.ok(r.out.includes('"pages"'));
  assert.deepEqual(r.geminiCalls, []);
});

test("Groq-primary preset (Groq 7s, then 3.5-flash on the rest): Groq hang -> Gemini answers within cap", async () => {
  const env = { ...ON, MLJ_PROVIDER_ORDER: "groq,gemini-primary", MLJ_GROQ_TIMEOUT_MS: "7000" };
  let primarySignalAt;
  const r = await runChain(env, {
    groqFetch: fakeFetch((i) => hang(i.signal)),
    gemini: { primary: async () => { primarySignalAt = Date.now(); return "gemini-ok"; }, fallback: async () => "x" },
    logs: [],
  });
  assert.equal(r.out, "gemini-ok");
  assert.ok(primarySignalAt >= 7000 && primarySignalAt < 8000, `primary started at ${primarySignalAt}`);
  // Gemini hanging too: still BUSY at <= 14.5s (primary clamped to ~7.2s left).
  const r2 = await runChain(env, { groqFetch: fakeFetch((i) => hang(i.signal)), gemini: { primary: hang, fallback: hang }, logs: [] });
  assert.equal(classifyError(r2.err), "BUSY");
  assert.ok(r2.ms <= SERVER_TIMEOUT_MS);
});

test("no user text or key in logs (retry log + logSafe) on Groq paths", async () => {
  const lines = [];
  const ow = console.warn, oe = console.error;
  console.warn = (s) => lines.push(String(s)); console.error = (s) => lines.push(String(s));
  try {
    for (const status of [200, 429, 500]) {
      const g = fakeFetch(() => status === 200 ? jsonRes(200, okBody) : jsonRes(status, { error: { message: USER_TEXT } }));
      const r = await runChain(ON, { gemini: both503, groqFetch: g });
      if (r.err) logSafe("generate", classifyError(r.err), r.err, { userTexts: [USER_TEXT] });
    }
  } finally { console.warn = ow; console.error = oe; }
  assert.ok(lines.length >= 3);
  const all = lines.join("\n");
  assert.ok(!all.includes(USER_TEXT) && !all.includes("wedding"), "no user text");
  assert.ok(!all.includes(KEY), "no key");
  assert.ok(all.includes('"answeredBy":"groq:openai/gpt-oss-120b"'));
});

function captureWarns(fn) {
  const lines = []; const ow = console.warn;
  console.warn = (s) => lines.push(String(s));
  try { fn(); } finally { console.warn = ow; }
  return lines;
}

test("order: exactly 'groq' -> Groq only (warned); default when Groq disabled", () => {
  resetConfigWarnings();
  let a;
  const lines = captureWarns(() => { a = chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: " groq " }); });
  assert.deepEqual(a.order, ["groq"]);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ warn: "provider-order", groqOnly: true }]);
  assert.ok(!lines.join().includes(KEY));
  assert.deepEqual(chainConfigFromEnv({ MLJ_PROVIDER_ORDER: "groq" }).order, ["gemini-primary", "gemini-lite"]);
});

test("order: typo order drops unknown (warned once), removes duplicates, keeps gemini-primary", () => {
  resetConfigWarnings();
  let cfg;
  const lines = captureWarns(() => {
    cfg = chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: "gemini-primary,gemni-lite,groq,gemini-primary,groq" });
    chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: "gemini-primary,bogus" });
  });
  assert.deepEqual(cfg.order, ["gemini-primary", "groq"]);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ warn: "provider-order", dropped: ["gemni-lite"] }]);
});

test("order: valid order without gemini-primary gets it appended (warned)", () => {
  resetConfigWarnings();
  let a, b;
  const lines = captureWarns(() => {
    a = chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: "gemini-lite,groq" });
    b = chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: "groq,typo" });
  });
  assert.deepEqual(a.order, ["gemini-lite", "groq", "gemini-primary"]);
  assert.deepEqual(b.order, ["groq", "gemini-primary"]);
  assert.deepEqual(JSON.parse(lines[0]), { warn: "provider-order", added: "gemini-primary", order: ["gemini-lite", "groq", "gemini-primary"] });
});

test("order: all-unknown order -> default", () => {
  resetConfigWarnings();
  let cfg;
  const lines = captureWarns(() => { cfg = chainConfigFromEnv({ ...ON, MLJ_PROVIDER_ORDER: "nope, ,also-nope" }); });
  assert.deepEqual(cfg.order, ["gemini-primary", "gemini-lite"]);
  assert.equal(lines.length, 1);
});

test("groq-only order: success answers; failure -> BUSY", async () => {
  resetConfigWarnings();
  const ow = console.warn; console.warn = () => {};
  try {
    const env = { ...ON, MLJ_PROVIDER_ORDER: "groq" };
    const ok = await runChain(env, { gemini: both503, logs: [] });
    assert.ok(ok.out.includes('"pages"'));
    const bad = await runChain(env, { gemini: both503, groqFetch: fakeFetch(() => jsonRes(401, {})), logs: [] });
    assert.equal(classifyError(bad.err), "BUSY");
  } finally { console.warn = ow; }
});

for (const [name, handler] of [
  ["non-JSON", () => new Response("<html>oops</html>", { status: 200 })],
  ["malformed JSON shape", () => jsonRes(200, { foo: 1 })],
]) {
  test(`Groq 200 ${name} body -> retryable: next provider answers, or BUSY when last`, async () => {
    const r = await runChain({ ...ON, MLJ_PROVIDER_ORDER: "groq,gemini-primary" },
      { groqFetch: fakeFetch(handler), gemini: { primary: async () => "gemini-ok", fallback: async () => "x" }, logs: [] });
    assert.equal(r.out, "gemini-ok");
    const last = await runChain(ON, { gemini: both503, groqFetch: fakeFetch(handler), logs: [] });
    assert.equal(classifyError(last.err), "BUSY");
  });
}

for (const status of [401, 403]) {
  test(`Groq ${status} -> GROQ_AUTH logged (status only, no key), Gemini still answers; BUSY when last`, async () => {
    const lines = [];
    const ow = console.warn; console.warn = (s) => lines.push(String(s));
    try {
      const g = fakeFetch(() => jsonRes(status, { error: { message: `invalid key ${KEY}` } }));
      const r = await runChain({ ...ON, MLJ_PROVIDER_ORDER: "groq,gemini-primary" },
        { groqFetch: g, gemini: { primary: async () => "gemini-ok", fallback: async () => "x" } });
      assert.equal(r.out, "gemini-ok");
      assert.equal(g.calls.length, 1);
      const last = await runChain(ON, { gemini: both503, groqFetch: fakeFetch(() => jsonRes(status, {})), logs: [] });
      assert.equal(classifyError(last.err), "BUSY");
    } finally { console.warn = ow; }
    const line = JSON.parse(lines.find((l) => l.includes("provider-chain")));
    assert.deepEqual(line.attempts[0], { provider: "groq", status, code: "GROQ_AUTH" });
    assert.equal(line.answeredBy, "gemini-primary");
    assert.ok(!lines.join().includes(KEY));
  });
}
