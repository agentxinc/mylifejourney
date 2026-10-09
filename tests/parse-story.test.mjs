import { test } from "node:test";
import assert from "node:assert/strict";
import { BadReplyError, parseStoryText, describeResponse } from "../src/lib/parse-story.mjs";
import { EmptyResultError, classifyError } from "../src/lib/generate-errors.mjs";

const page = { eventId: "1", title: "Arrival", date: "2018-08-15", narrative: "N", pageNumber: 1 };
const story = { title: "T", subtitle: "S", pages: [page] };

test("plain JSON object (the prompt's shape)", () => {
  assert.deepEqual(parseStoryText(JSON.stringify(story)), story);
});

test("```json fenced and prose-wrapped replies", () => {
  assert.deepEqual(parseStoryText("```json\n" + JSON.stringify(story) + "\n```"), story);
  assert.deepEqual(parseStoryText("Here is your story:\n" + JSON.stringify(story) + "\nEnjoy!"), story);
});

test("prose with braces before the JSON keeps title and subtitle", () => {
  const parsed = parseStoryText("A {smile} for you: " + JSON.stringify(story));
  assert.equal(parsed.title, "T");
  assert.equal(parsed.subtitle, "S");
});

test("braces after the JSON, and many braces before it, keep the title", () => {
  assert.equal(parseStoryText(JSON.stringify(story) + " Hope you {smile}!").title, "T");
  assert.equal(parseStoryText("{x} ".repeat(30) + JSON.stringify(story) + " {y}").subtitle, "S");
});

test("nested under one key, chapters instead of pages, bare array", () => {
  assert.equal(parseStoryText(JSON.stringify({ story })).title, "T");
  assert.equal(parseStoryText(JSON.stringify({ title: "T", chapters: [page] })).pages.length, 1);
  const bare = parseStoryText(JSON.stringify([{ ...page, pageNumber: undefined }, page]));
  assert.equal(bare.pages.length, 2);
  assert.equal(bare.pages[0].pageNumber, 1);
  assert.equal(parseStoryText(JSON.stringify([story])).title, "T");
});

test("junk pages are not a story", () => {
  for (const text of ['{"pages":[null]}', "[{}]", "[[[[{}]]]]", '{"pages":[{"date":"x"}]}', '{"pages":[1,2]}']) {
    assert.throws(() => parseStoryText(text), EmptyResultError, text);
  }
});

test("unreadable reply -> BadReplyError -> SERVER; readable with no pages -> EMPTY", () => {
  for (const [text, Err, reason, code] of [
    ["", BadReplyError, "empty response", "SERVER"],
    ["   ", BadReplyError, "empty response", "SERVER"],
    ["not json at all", BadReplyError, "invalid JSON", "SERVER"],
    ['{"title":"T","pages":[{"title":"cut', BadReplyError, "invalid JSON", "SERVER"],
    ['{"title":"T","pages":[]}', EmptyResultError, "no pages", "EMPTY"],
    ['{"error":"blocked"}', EmptyResultError, "no pages", "EMPTY"],
  ]) {
    let caught;
    assert.throws(() => parseStoryText(text), (e) => ((caught = e), e instanceof Err && e.message === reason));
    assert.equal(classifyError(caught), code, text);
  }
  assert.equal(classifyError(new BadReplyError("finishReason MAX_TOKENS")), "SERVER");
  assert.equal(classifyError(new SyntaxError("bad json")), "SERVER");
});

test("describeResponse logs shape only: no text, no model-chosen keys", () => {
  const d = describeResponse(JSON.stringify({ "Trip to Goa": 1, title: "Arrival" }), { finishReason: "STOP" });
  assert.equal(d.keyCount, 2);
  assert.equal(d.hasTitle, true);
  assert.ok(!JSON.stringify(d).includes("Goa"));
  assert.ok(!JSON.stringify(d).includes("Arrival"));
  const blocked = describeResponse("", { blockReason: "SAFETY" });
  assert.equal(blocked.blockReason, "SAFETY");
  assert.equal(blocked.textLength, 0);
  assert.equal(describeResponse("Hello").firstChar, "other");
});

test("pathological input stays fast", () => {
  const t = Date.now();
  for (const s of ["{".repeat(1e6), "[".repeat(1e6), "```".repeat(3e5)]) {
    assert.throws(() => parseStoryText(s));
  }
  assert.ok(Date.now() - t < 2000);
});
