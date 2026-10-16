import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildGeneratePrompt,
  buildImprovePrompt,
  isImageString,
  reattachImages,
  reattachStoryImages,
  stripEventImages,
  stripStoryImages,
} from "../src/lib/strip-images.mjs";

const RAW_B64 = "iVBORw0KGgo" + "A".repeat(400);
const photo = (n, kb = 1) => `data:image/jpeg;base64,/9j/${"Q".repeat(kb * 1024)}${n}`;
const HAS_IMAGE = /data:|base64|iVBORw0KGgo|\/9j\//i;

const events = () => [
  { id: "ev-1", title: "First day", date: "2018-08-15", description: "School", imageUrl: photo(1) },
  { id: "ev-2", title: "Wedding", date: "2020-05-01", description: "Beach", imageUrl: photo(2), image: RAW_B64 },
  { id: "ev-3", title: "Trip", date: "2022-01-09", description: "Goa", imageUrl: null, photoUrl: photo(3), imageFile: {} },
];
const storyOf = (evs) => ({
  title: "My Life", subtitle: "So far", generatedAt: "2026-10-16T00:00:00Z",
  pages: evs.map((e, i) => ({ eventId: e.id, title: e.title, date: e.date, narrative: `n${i}`, imageUrl: e.imageUrl, pageNumber: i + 1 })),
});

/** Mocked fetch: records the JSON body, answers with `reply(body)`. Never touches the network. */
function mockFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, raw: init.body, body });
    return { ok: true, status: 200, json: async () => reply(body) };
  };
  return { fetch, calls };
}

/** Same steps as page.tsx generateStory / improveStory. */
async function clientGenerate(fetch, evs) {
  const res = await fetch("/api/generate", { method: "POST", body: JSON.stringify({ events: stripEventImages(evs) }) });
  return reattachStoryImages(await res.json(), evs);
}
async function clientImprove(fetch, story, feedback) {
  const res = await fetch("/api/improve", { method: "POST", body: JSON.stringify({ story: stripStoryImages(story), feedback }) });
  return reattachStoryImages(await res.json(), story.pages);
}

test("isImageString: data: URLs and long base64 yes, prose and short ids no", () => {
  assert.equal(isImageString(photo(1)), true);
  assert.equal(isImageString(RAW_B64), true);
  assert.equal(isImageString("A lovely day at the beach"), false);
  assert.equal(isImageString("ev-1"), false);
  assert.equal(isImageString(null), false);
});

test("generate prompt has no data: or base64, even when events carry photos", () => {
  const prompt = buildGeneratePrompt(events());
  assert.doesNotMatch(prompt, HAS_IMAGE);
  assert.doesNotMatch(prompt, /imageUrl/);
  assert.match(prompt, /"Wedding" on 2020-05-01\. Description: Beach/);
});

test("improve prompt has no data: or base64, and no imageUrl key", () => {
  const story = storyOf(events());
  story.pages[0].thumbnail = RAW_B64;
  story.cover = photo(9);
  const prompt = buildImprovePrompt(story, "make it funnier");
  assert.doesNotMatch(prompt, HAS_IMAGE);
  assert.doesNotMatch(prompt, /imageUrl|thumbnail|cover/);
  assert.match(prompt, /"narrative": "n1"/);
});

test("server strip: old-client image fields are dropped, text fields kept (no 400)", () => {
  const out = stripEventImages(events());
  assert.deepEqual(out[1], { id: "ev-2", title: "Wedding", date: "2020-05-01", description: "Beach" });
  assert.doesNotMatch(JSON.stringify(out), HAS_IMAGE);
  const s = stripStoryImages(storyOf(events()));
  assert.doesNotMatch(JSON.stringify(s), HAS_IMAGE);
  assert.equal(s.pages.length, 3);
  assert.equal(s.pages[2].eventId, "ev-3");
  assert.equal(stripEventImages("not an array"), "not an array", "validation still sees bad input as-is");
});

test("routes strip before validation, Gemini and logging", () => {
  const gen = readFileSync(new URL("../src/app/api/generate/route.ts", import.meta.url), "utf8");
  const imp = readFileSync(new URL("../src/app/api/improve/route.ts", import.meta.url), "utf8");
  const gi = (s, n) => s.indexOf(n);
  assert.ok(gi(gen, "events = stripEventImages(events)") > 0);
  assert.ok(gi(gen, "events = stripEventImages(events)") < gi(gen, "validateEvents(events)"));
  assert.ok(gi(gen, "events = stripEventImages(events)") < gi(gen, "generateStoryFromEvents(events"));
  assert.ok(gi(imp, "story = stripStoryImages(story)") > 0);
  assert.ok(gi(imp, "story = stripStoryImages(story)") < gi(imp, "improveStory(story"));
  assert.ok(gi(imp, "story = stripStoryImages(story)") < gi(imp, "logSafe("));
  const gem = readFileSync(new URL("../src/lib/gemini.ts", import.meta.url), "utf8");
  assert.match(gem, /buildGeneratePrompt\(sorted\)/);
  assert.match(gem, /buildImprovePrompt\(currentStory, feedback\)/);
  assert.doesNotMatch(gem, /JSON\.stringify\(currentStory/);
});

test("page.tsx strips before POST and re-attaches after", () => {
  const src = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(src, /postForStory\("\/api\/generate", \{ events: stripEventImages\(events\) \}\)/);
  assert.match(src, /postForStory\("\/api\/improve", \{ story: stripStoryImages\(story\), feedback \}\)/);
  assert.match(src, /reattachStoryImages\(data, events\)/);
  assert.match(src, /reattachStoryImages\(data, story\.pages\)/);
});

test("generate round trip (mocked fetch): body has no images, photos come back on pages", async () => {
  const evs = events();
  const { fetch, calls } = mockFetch((b) => storyOf(b.events));
  const story = await clientGenerate(fetch, evs);
  assert.doesNotMatch(calls[0].raw, HAS_IMAGE);
  assert.doesNotMatch(calls[0].raw, /imageUrl/);
  assert.equal(story.pages[0].imageUrl, evs[0].imageUrl);
  assert.equal(story.pages[1].imageUrl, evs[1].imageUrl);
  assert.equal(story.pages[2].imageUrl, null);
});

test("improve round trip (mocked fetch): reordered + renamed pages keep every photo by id", async () => {
  const original = storyOf(events());
  original.pages[2].imageUrl = photo(3);
  const { fetch, calls } = mockFetch((b) => ({
    ...b.story,
    title: "New title",
    pages: [b.story.pages[2], b.story.pages[0], b.story.pages[1]].map((p, i) => ({ ...p, title: `Renamed ${i}`, pageNumber: i + 1 })),
  }));
  const improved = await clientImprove(fetch, original, "shorter");
  assert.doesNotMatch(calls[0].raw, HAS_IMAGE);
  assert.doesNotMatch(calls[0].raw, /imageUrl/);
  assert.deepEqual(improved.pages.map((p) => p.eventId), ["ev-3", "ev-1", "ev-2"]);
  for (const p of improved.pages) {
    assert.equal(p.imageUrl, original.pages.find((o) => o.eventId === p.eventId).imageUrl);
  }
  // PdfDocument / StoryPreview read page.imageUrl: every original photo is still there.
  assert.deepEqual(new Set(improved.pages.map((p) => p.imageUrl)), new Set(original.pages.map((p) => p.imageUrl)));
});

test("re-attach falls back to the original page's image by index when an id is missing or unknown", () => {
  const orig = storyOf(events()).pages;
  const out = reattachImages(
    [{ title: "a" }, { eventId: "made-up", title: "b" }, { eventId: "ev-1", title: "c" }],
    orig
  );
  assert.equal(out[0].imageUrl, orig[0].imageUrl);
  assert.equal(out[1].imageUrl, orig[1].imageUrl);
  assert.equal(out[2].imageUrl, orig[0].imageUrl, "known id wins over index");
  assert.equal(reattachImages([{ title: "x" }], []).at(0).imageUrl, null);
});

test("near-4 MB of base64 photos: stripped generate/improve bodies stay under 100 KB", async () => {
  // 8 entries x ~500 KB photos ~= 4 MB raw, near Vercel's 4.5 MB body limit.
  const big = Array.from({ length: 8 }, (_, i) => ({
    id: `ev-${i}`, title: `Moment ${i}`, date: `20${10 + i}-06-01`,
    description: "A typical entry with a couple of sentences about what happened that day.",
    imageUrl: photo(i, 500),
  }));
  const rawGen = JSON.stringify({ events: big });
  assert.ok(rawGen.length > 3.9 * 1024 * 1024, `fixture is ~4 MB (${rawGen.length})`);

  const { fetch, calls } = mockFetch((b) => (b.events ? storyOf(b.events) : b.story));
  const story = await clientGenerate(fetch, big);
  const rawImp = JSON.stringify({ story, feedback: "warmer" });
  assert.ok(rawImp.length > 3.9 * 1024 * 1024, "re-attached story is ~4 MB on the client");
  await clientImprove(fetch, story, "warmer");

  for (const c of calls) {
    assert.ok(c.raw.length < 100 * 1024, `${c.url} body ${c.raw.length} B < 100 KB`);
    assert.doesNotMatch(c.raw, HAS_IMAGE);
  }
  assert.doesNotMatch(buildGeneratePrompt(big), HAS_IMAGE);
  assert.doesNotMatch(buildImprovePrompt(story, "warmer"), HAS_IMAGE);
});
