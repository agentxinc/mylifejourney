import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStoryText, describeResponse } from "../src/lib/parse-story.mjs";
import { EmptyResultError } from "../src/lib/generate-errors.mjs";

const page = { eventId: "1", title: "Arrival", date: "2018-08-15", narrative: "N", pageNumber: 1 };
const story = { title: "T", subtitle: "S", pages: [page] };

test("plain JSON object (the prompt's shape)", () => {
  assert.deepEqual(parseStoryText(JSON.stringify(story)), story);
});

test("```json fenced and prose-wrapped replies", () => {
  assert.deepEqual(parseStoryText("```json\n" + JSON.stringify(story) + "\n```"), story);
  assert.deepEqual(parseStoryText("Here is your story:\n" + JSON.stringify(story) + "\nEnjoy!"), story);
});

test("nested under one key, chapters instead of pages, bare array", () => {
  assert.equal(parseStoryText(JSON.stringify({ story })).title, "T");
  assert.equal(parseStoryText(JSON.stringify({ title: "T", chapters: [page] })).pages.length, 1);
  const bare = parseStoryText(JSON.stringify([{ ...page, pageNumber: undefined }, page]));
  assert.equal(bare.pages.length, 2);
  assert.equal(bare.pages[0].pageNumber, 1);
  assert.equal(parseStoryText(JSON.stringify([story])).title, "T");
});

test("still EMPTY when there truly is no story", () => {
  for (const [text, reason] of [
    ["", "empty response"],
    ["   ", "empty response"],
    ["not json at all", "invalid JSON"],
    ['{"title":"T","pages":[]}', "no pages"],
    ['{"error":"blocked"}', "no pages"],
  ]) {
    assert.throws(() => parseStoryText(text), (e) => e instanceof EmptyResultError && e.message === reason);
  }
});

test("describeResponse logs shape only, never text", () => {
  const d = describeResponse("```json\n" + JSON.stringify(story) + "\n```", "STOP");
  assert.deepEqual(d.topKeys, ["title", "subtitle", "pages"]);
  assert.equal(d.finishReason, "STOP");
  assert.equal(d.fenced, true);
  assert.ok(!JSON.stringify(d).includes("Arrival"));
});
