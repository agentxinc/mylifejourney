import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUSY_WAIT_COPY,
  CLIENT_TIMEOUT_MS,
  SERVER_TIMEOUT_MS,
  EmptyResultError,
  GENERATE_ERROR_COPY,
  IMPROVE_ERROR_COPY,
  TimeoutError,
  classifyError,
  classifyFetchFailure,
  errorPayload,
  getMock,
  isUsableStory,
  mockResponse,
  parseErrorResponse,
  validateEvents,
  withTimeout,
} from "../src/lib/generate-errors.mjs";

const URL_WITH = (m) => `http://localhost:3000/api/generate?mock=${m}`;
const roundTrip = async (res) =>
  parseErrorResponse(res.status, await res.text(), res.headers.get("Retry-After"));

test("timeouts: server cutoff fires before the page cutoff", () => {
  assert.equal(SERVER_TIMEOUT_MS, 25_000);
  assert.equal(CLIENT_TIMEOUT_MS, 30_000);
  assert.ok(SERVER_TIMEOUT_MS < CLIENT_TIMEOUT_MS);
});

test("BUSY: Gemini quota / 429 / 503 map to BUSY with Retry-After", async () => {
  assert.equal(classifyError({ status: 429, message: "x" }), "BUSY");
  assert.equal(classifyError(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')), "BUSY");
  assert.equal(classifyError({ status: 503 }), "BUSY");
  const parsed = await roundTrip(await mockResponse("busy"));
  assert.deepEqual(parsed, { code: "BUSY", retryAfterSec: 30 });
});

test("TIMEOUT: our own cutoff and Gemini deadline map to TIMEOUT", async () => {
  let seen;
  await assert.rejects(withTimeout((signal) => { seen = signal; return new Promise(() => {}); }, 10), TimeoutError);
  assert.equal(seen.aborted, true, "cutoff aborts the upstream call");
  assert.equal(await withTimeout(async (signal) => (signal.aborted ? "x" : "ok"), 50), "ok");
  assert.equal(classifyError(new TimeoutError()), "TIMEOUT");
  assert.equal(classifyError(new Error("DEADLINE_EXCEEDED")), "TIMEOUT");
  assert.equal((await roundTrip(await mockResponse("timeout"))).code, "TIMEOUT");
});

test("BAD_INPUT: names the first missing field and event", async () => {
  assert.deepEqual(validateEvents([]), { field: "events" });
  assert.deepEqual(
    validateEvents([{ id: "a", title: "T", date: "2020-01-01" }, { id: "b", title: "T2", date: "" }]),
    { field: "events[1].date", eventId: "b" }
  );
  assert.deepEqual(validateEvents([{ id: "c", title: " ", date: "2020-01-01" }]), {
    field: "events[0].title",
    eventId: "c",
  });
  assert.equal(validateEvents([{ id: "a", title: "T", date: "2020-01-01" }]), null);
  const p = errorPayload("BAD_INPUT", { field: "events[1].date", eventId: "b" });
  const parsed = parseErrorResponse(p.status, JSON.stringify(p.body), null);
  assert.deepEqual(parsed, { code: "BAD_INPUT", field: "date", eventId: "b" });
});

test("EMPTY: only a readable reply with no pages; bad JSON is SERVER", async () => {
  assert.equal(classifyError(new EmptyResultError("no pages")), "EMPTY");
  assert.equal(classifyError(new SyntaxError("bad json")), "SERVER");
  assert.equal((await roundTrip(await mockResponse("empty"))).code, "EMPTY");
  assert.equal(isUsableStory({ pages: [] }), false);
  assert.equal(isUsableStory({}), false);
  assert.equal(isUsableStory({ pages: [{}] }), true);
});

test("SERVER: anything else maps to SERVER and never leaks provider text", async () => {
  assert.equal(classifyError(new Error("GEMINI_API_KEY environment variable is not set")), "SERVER");
  const body = await (await mockResponse("500")).text();
  assert.equal(JSON.parse(body).error.code, "SERVER");
  assert.ok(!/GEMINI|api key/i.test(body));
});

test("OFFLINE: fetch TypeError or navigator offline map to OFFLINE; our abort maps to TIMEOUT", () => {
  assert.deepEqual(classifyFetchFailure(new TypeError("Failed to fetch"), false), { code: "OFFLINE" });
  assert.deepEqual(classifyFetchFailure(new Error("x"), false, false), { code: "OFFLINE" });
  assert.deepEqual(classifyFetchFailure(new DOMException("aborted", "AbortError"), true), { code: "TIMEOUT" });
});

test("platform errors with non-JSON bodies are mapped by status", async () => {
  assert.equal((await roundTrip(await mockResponse("html504"))).code, "TIMEOUT");
  assert.equal(parseErrorResponse(429, "<html>", null).code, "BUSY");
  assert.equal(parseErrorResponse(503, "", "12").retryAfterSec, 12);
  assert.equal(parseErrorResponse(502, "<html>", null).code, "SERVER");
  assert.equal(parseErrorResponse(500, "{\"error\":\"old string shape\"}", null).code, "SERVER");
});

test("slow mock waits 35s (past the 30s page cutoff) before answering", async () => {
  let slept = 0;
  const res = await mockResponse("slow", { sleep: async (ms) => { slept = ms; } });
  assert.equal(slept, 35_000);
  assert.ok(slept > CLIENT_TIMEOUT_MS);
  assert.equal(res.status, 504);
});

test("mock bad flags the entry that is really missing a field, else the first title", async () => {
  const events = [
    { id: "ev-1", title: "A", date: "2018-08-15" },
    { id: "ev-2", title: "B", date: "" },
  ];
  assert.deepEqual(await roundTrip(await mockResponse("bad", { events })), {
    code: "BAD_INPUT",
    field: "date",
    eventId: "ev-2",
  });
  assert.deepEqual(await roundTrip(await mockResponse("bad", { events: [events[0]] })), {
    code: "BAD_INPUT",
    field: "title",
    eventId: "ev-1",
  });
  assert.deepEqual(await roundTrip(await mockResponse("bad")), { code: "BAD_INPUT", field: "title" });
});

test("countdown copy is UI's exact line", () => {
  assert.equal(
    BUSY_WAIT_COPY,
    "We're at capacity right now \u2014 you can try again in a moment. Your entries are still here."
  );
});

test("mock switch: honored locally/Preview, ignored in Production", () => {
  for (const m of ["busy", "timeout", "bad", "empty", "500", "html504", "slow"]) {
    assert.equal(getMock(URL_WITH(m), undefined), m);
    assert.equal(getMock(URL_WITH(m), "preview"), m);
    assert.equal(getMock(URL_WITH(m), "production"), null);
  }
  assert.equal(getMock(URL_WITH("nope"), undefined), null);
  assert.equal(getMock("http://localhost/api/generate", undefined), null);
});

test("copy: every state says entries are still here (except BAD_INPUT); Regenerate EMPTY keeps the original", () => {
  for (const [code, text] of Object.entries(GENERATE_ERROR_COPY)) {
    if (code === "BAD_INPUT" || code === "EMPTY") continue;
    assert.match(text, /Your entries are still here/);
  }
  assert.doesNotMatch(Object.values(GENERATE_ERROR_COPY).join(" "), /saved/i);
  assert.equal(IMPROVE_ERROR_COPY.EMPTY, "We couldn't improve this one — your original is unchanged.");
});
