import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GENERATE_ERROR_COPY,
  IMPROVE_ERROR_COPY,
  parseErrorResponse,
  storyFromResponse,
} from "../src/lib/generate-errors.mjs";
import { stripEventImages, stripStoryImages } from "../src/lib/strip-images.mjs";

/** Mocked fetch answering with a fixed status/body. No network. */
const mockFetch = (status, body, headers = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  headers: { get: (k) => headers[k] ?? null },
});

/** Same steps as page.tsx postForStory + showError's copy lookup. */
async function run(fetch, path, payload, copy) {
  const res = await fetch(path, { method: "POST", body: JSON.stringify(payload) });
  const text = await res.text();
  try {
    return { story: storyFromResponse({ ok: res.ok, status: res.status, text, retryAfter: res.headers.get("Retry-After") }) };
  } catch (e) {
    assert.equal(typeof e.code, "string", "always a ClientError, never a raw Error");
    return { error: e, message: copy[e.code] };
  }
}

const VERCEL_413 = "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n\niad1::abc123";
const HTML_500 = "<!DOCTYPE html><html><body><h1>500</h1>Internal Server Error</body></html>";
const events = [{ id: "ev-1", title: "Wedding", date: "2020-05-01", description: "Beach", imageUrl: "data:image/jpeg;base64,/9j/AAA" }];
const story = { title: "T", subtitle: "S", pages: [{ eventId: "ev-1", title: "W", date: "2020-05-01", narrative: "n", imageUrl: "data:image/jpeg;base64,/9j/AAA", pageNumber: 1 }] };

const REFRESH_COPY = "Refresh the page and try again. Your entries are still here.";

for (const [name, body] of [
  ["413 text page", VERCEL_413],
  ["413 with JSON BAD_INPUT body", JSON.stringify({ error: { code: "BAD_INPUT", field: "events[0].title" } })],
  ["413 with JSON SERVER body", JSON.stringify({ error: { code: "SERVER" } })],
  ["413 HTML page", "<html><body>413 Payload Too Large</body></html>"],
  ["413 empty body", ""],
]) {
  test(`${name}: generate and improve show the exact refresh copy, entries kept`, async () => {
    const evBefore = JSON.stringify(events);
    const stBefore = JSON.stringify(story);
    const gen = await run(mockFetch(413, body), "/api/generate", { events: stripEventImages(events) }, GENERATE_ERROR_COPY);
    const imp = await run(mockFetch(413, body), "/api/improve", { story: stripStoryImages(story), feedback: "x" }, IMPROVE_ERROR_COPY);
    for (const r of [gen, imp]) {
      assert.equal(r.story, undefined);
      assert.equal(r.error.code, "TOO_LARGE");
      assert.equal(r.message, REFRESH_COPY);
      assert.equal(r.error.field, undefined);
    }
    assert.equal(JSON.stringify(events), evBefore, "entries untouched");
    assert.equal(JSON.stringify(story), stBefore, "story untouched");
  });
}

test("refresh copy is King's exact line, in both flows", () => {
  assert.equal(GENERATE_ERROR_COPY.TOO_LARGE, REFRESH_COPY);
  assert.equal(IMPROVE_ERROR_COPY.TOO_LARGE, REFRESH_COPY);
  assert.deepEqual(parseErrorResponse(413, VERCEL_413, "30"), { code: "TOO_LARGE" });
});

for (const [name, status, body] of [
  ["500 HTML page", 500, HTML_500],
  ["400 non-JSON body", 400, "Bad Request"],
  ["502 empty body", 502, ""],
]) {
  test(`${name}: generate and improve show the normal try-again copy, entries kept`, async () => {
    const evBefore = JSON.stringify(events);
    const stBefore = JSON.stringify(story);
    const gen = await run(mockFetch(status, body), "/api/generate", { events: stripEventImages(events) }, GENERATE_ERROR_COPY);
    const imp = await run(mockFetch(status, body), "/api/improve", { story: stripStoryImages(story), feedback: "x" }, IMPROVE_ERROR_COPY);
    for (const r of [gen, imp]) {
      assert.equal(r.story, undefined);
      assert.equal(r.error.code, "SERVER");
      assert.equal(r.message, GENERATE_ERROR_COPY.SERVER);
      assert.match(r.message, /Your entries are still here/);
      assert.ok(r.message.trim().length > 0, "never blank");
      assert.ok(!r.message.includes(body.slice(0, 20)) || body === "", "never raw body text");
      assert.equal(r.error.field, undefined, "no field to hunt for");
    }
    assert.equal(JSON.stringify(events), evBefore, "entries untouched");
    assert.equal(JSON.stringify(story), stBefore, "story untouched");
  });
}

test("status mapping still works for non-JSON platform pages that have meaning", () => {
  assert.equal(parseErrorResponse(429, "<html>", "12").code, "BUSY");
  assert.equal(parseErrorResponse(504, "<html>", null).code, "TIMEOUT");
  assert.equal(parseErrorResponse(400, JSON.stringify({ error: { code: "BAD_INPUT", field: "events[0].date", eventId: "a" } }), null).field, "date");
});

test("200 with a non-JSON body is EMPTY (try again), not a crash", async () => {
  const r = await run(mockFetch(200, "<html>oops</html>"), "/api/generate", { events: [] }, GENERATE_ERROR_COPY);
  assert.equal(r.error.code, "EMPTY");
  assert.ok(r.message.length > 0);
});

test("page.tsx routes every response through storyFromResponse", () => {
  const src = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(src, /return storyFromResponse\(\{/);
  assert.doesNotMatch(src, /throw parseErrorResponse\(/);
});
