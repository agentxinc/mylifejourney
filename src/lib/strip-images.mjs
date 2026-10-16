// Photos never leave the browser for Gemini. These helpers strip image data
// from request bodies (client) and defensively again on the server, and put
// photos back on the story the client receives.

/** Keys that carry image data and are never sent to /api/* or Gemini. */
export const IMAGE_KEYS = new Set([
  "imageUrl", "imageFile", "image", "images", "imageData", "imageBase64",
  "photo", "photos", "photoUrl", "picture", "thumbnail", "base64", "dataUrl",
]);

const DATA_URL_RE = /^\s*data:/i;
// A long run of base64 alphabet with no spaces: an inline photo, not prose.
const BASE64_RE = /^[A-Za-z0-9+/=_-]{200,}$/;

/** True for a string that is a data: URL or looks like raw base64. */
export function isImageString(v) {
  return typeof v === "string" && (DATA_URL_RE.test(v) || BASE64_RE.test(v.trim()));
}

/** Copy of one plain object with image keys and image strings removed. */
function stripObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (IMAGE_KEYS.has(k) || isImageString(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Events without imageUrl / base64 / any image field. Non-arrays pass through. */
export function stripEventImages(events) {
  return Array.isArray(events) ? events.map(stripObject) : events;
}

/** Story (title, subtitle, pages) without any image data. */
export function stripStoryImages(story) {
  if (!story || typeof story !== "object") return story;
  const top = stripObject(story);
  if (Array.isArray(story.pages)) top.pages = story.pages.map(stripObject);
  return top;
}

/**
 * Put photos back on returned pages. Match by eventId (Improve may reorder or
 * retitle pages); if a page's id is missing or unknown, fall back to the
 * source item at the same index. `sources` are events ({id, imageUrl}) or
 * original pages ({eventId, imageUrl}).
 */
export function reattachImages(pages, sources) {
  const list = Array.isArray(sources) ? sources : [];
  const byId = new Map();
  for (const s of list) {
    const id = s?.eventId ?? s?.id;
    if (id != null && s?.imageUrl) byId.set(String(id), s.imageUrl);
  }
  return (Array.isArray(pages) ? pages : []).map((page, i) => {
    const id = page?.eventId;
    const img = id != null && byId.has(String(id)) ? byId.get(String(id)) : list[i]?.imageUrl ?? null;
    return { ...page, imageUrl: img ?? null };
  });
}

/** Re-attach photos to a whole story response. */
export function reattachStoryImages(story, sources) {
  if (!story || !Array.isArray(story.pages)) return story;
  return { ...story, pages: reattachImages(story.pages, sources) };
}

/** Prompt for /api/generate. Uses only title, date and description. */
export function buildGeneratePrompt(events) {
  const eventDescriptions = stripEventImages(events)
    .map((e, i) => `Event ${i + 1}: "${e.title}" on ${e.date}. Description: ${e.description}`)
    .join("\n");

  return `You are a creative storyteller creating a personalized life journey slambook.
Given these life events, create a beautiful narrative for each event that reads like a storybook.

Life Events:
${eventDescriptions}

Respond in JSON format with this exact structure:
{
  "title": "A creative title for this life journey",
  "subtitle": "A touching subtitle",
  "pages": [
    {
      "eventId": "the event id",
      "title": "Chapter title for this event",
      "date": "the date",
      "narrative": "A 2-3 paragraph beautiful narrative about this life event, written in a warm, personal storytelling style. Make it emotional and vivid.",
      "pageNumber": 1
    }
  ]
}

Make the narratives personal, warm, and vivid. Each narrative should be 2-3 paragraphs that paint a picture of the moment. Use sensory details and emotions.`;
}

/** Prompt for /api/improve. The story is stripped of all image data first. */
export function buildImprovePrompt(story, feedback) {
  return `You are a creative storyteller improving a personalized life journey slambook.

Here is the current storybook:
${JSON.stringify(stripStoryImages(story), null, 2)}

The user wants these improvements:
"${feedback}"

Please regenerate the storybook with the requested improvements. Keep the same structure but apply the changes.

Respond in JSON format with this exact structure:
{
  "title": "Updated title if needed",
  "subtitle": "Updated subtitle if needed",
  "pages": [
    {
      "eventId": "the event id",
      "title": "Chapter title",
      "date": "the date",
      "narrative": "Updated narrative",
      "pageNumber": 1
    }
  ]
}`;
}
