import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGE_REQUIREMENT,
  GEMINI_TERMS_URL,
  GENERATE_NOTE,
  GOOGLE_PRIVACY_URL,
} from "../src/lib/privacy-copy.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("approved copy is exact", () => {
  assert.equal(GENERATE_NOTE, "Sent to Google Gemini to write your story. Avoid sensitive details.");
  assert.equal(AGE_REQUIREMENT, "You must be 18 or older to use mylifejourney.");
  assert.equal(GEMINI_TERMS_URL, "https://ai.google.dev/gemini-api/terms");
  assert.equal(GOOGLE_PRIVACY_URL, "https://policies.google.com/privacy");
});

test("privacy page links both Google URLs and has both sections", () => {
  const src = read("../src/app/privacy/page.tsx");
  assert.match(src, /href=\{GEMINI_TERMS_URL\}/);
  assert.match(src, /href=\{GOOGLE_PRIVACY_URL\}/);
  assert.match(src, /How your story is written \(Google Gemini\)/);
  assert.match(src, /trained human reviewers may read it/);
  assert.match(src, /Who can use mylifejourney/);
});

test("Generate button is described by an always-rendered note linking /privacy", () => {
  const src = read("../src/app/page.tsx");
  assert.match(src, /aria-describedby="generate-privacy-note"/);
  assert.match(src, /<p id="generate-privacy-note"/);
  assert.match(src, /href="\/privacy"/);
});
