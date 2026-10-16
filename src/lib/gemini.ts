import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { LifeEvent, StoryPage } from "@/types";
import { BadReplyError, describeResponse, parseStoryText } from "@/lib/parse-story.mjs";
import { buildGeneratePrompt, buildImprovePrompt, reattachImages } from "@/lib/strip-images.mjs";

/**
 * Story replies are long JSON. Leave plenty of output room and keep thinking
 * low so reasoning tokens can't crowd out the story (finishReason MAX_TOKENS).
 */
const STORY_CONFIG = {
  responseMimeType: "application/json",
  maxOutputTokens: 16384,
  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
};

type GeminiReply = {
  text?: string;
  candidates?: { finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
};

/**
 * Parse Gemini's reply. A blocked prompt or a finishReason other than STOP
 * (MAX_TOKENS, SAFETY, ...) is a bad reply -> SERVER. On any failure, log the
 * reply's shape (never its text) and rethrow.
 */
function parseStoryJson(
  route: string,
  response: GeminiReply
): { title?: string; subtitle?: string; pages: StoryPage[] } {
  let text = "";
  const finishReason = response.candidates?.[0]?.finishReason;
  const blockReason = response.promptFeedback?.blockReason;
  try {
    text = response.text ?? "";
    if (blockReason) throw new BadReplyError(`blocked ${String(blockReason)}`);
    if (finishReason !== undefined && finishReason !== "STOP") {
      throw new BadReplyError(`finishReason ${String(finishReason)}`);
    }
    return parseStoryText(text) as { title?: string; subtitle?: string; pages: StoryPage[] };
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown };
    console.error(
      JSON.stringify({
        route,
        parse: e instanceof BadReplyError || e?.name === "EmptyResultError" ? e.message : e?.name ?? "unknown",
        ...describeResponse(text, { finishReason, blockReason }),
      })
    );
    throw err;
  }
}

/** Gemini 2.5* is limited to prior users; new API keys get 404 NOT_FOUND. */
const DEFAULT_MODEL = "gemini-3.5-flash";
/** Used once when the primary is overloaded (503) or slow. */
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";

export type ModelChoice = "primary" | "fallback";

function getModel(which: ModelChoice = "primary"): string {
  if (which === "fallback") {
    return process.env.GEMINI_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL;
  }
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }
  return new GoogleGenAI({ apiKey });
}

export async function generateStoryFromEvents(
  events: LifeEvent[],
  abortSignal?: AbortSignal,
  which: ModelChoice = "primary"
): Promise<{ title: string; subtitle: string; pages: StoryPage[] }> {
  const ai = getClient();

  // Sorted copy; photos are never part of the prompt (see strip-images.mjs).
  const sorted = [...events].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const prompt = buildGeneratePrompt(sorted);

  const response = await ai.models.generateContent({
    model: getModel(which),
    contents: prompt,
    config: {
      ...STORY_CONFIG,
      // Cancels the HTTP call at our cutoff. Per the SDK, the provider may
      // still bill work already started; this stops us waiting on it.
      abortSignal,
    },
  });

  const parsed = parseStoryJson("generate", response);

  // Keep ids aligned to events; the server never holds photos, so imageUrl
  // stays null here and the client re-attaches its own photos by id.
  const pages: StoryPage[] = parsed.pages.map(
    (page: StoryPage, index: number) => ({
      ...page,
      eventId: sorted[index]?.id ?? page.eventId,
      imageUrl: null,
    })
  );

  return {
    title: parsed.title ?? "",
    subtitle: parsed.subtitle ?? "",
    pages,
  };
}

export async function improveStory(
  currentStory: { title: string; subtitle: string; pages: StoryPage[] },
  feedback: string,
  abortSignal?: AbortSignal,
  which: ModelChoice = "primary"
): Promise<{ title: string; subtitle: string; pages: StoryPage[] }> {
  const ai = getClient();

  const prompt = buildImprovePrompt(currentStory, feedback);

  const response = await ai.models.generateContent({
    model: getModel(which),
    contents: prompt,
    config: {
      ...STORY_CONFIG,
      // Cancels the HTTP call at our cutoff. Per the SDK, the provider may
      // still bill work already started; this stops us waiting on it.
      abortSignal,
    },
  });

  const parsed = parseStoryJson("improve", response);

  // Re-attach by eventId (index fallback); a no-op when the route already
  // stripped photos, since then currentStory carries none.
  const pages: StoryPage[] = reattachImages(parsed.pages, currentStory.pages) as StoryPage[];

  return {
    title: parsed.title ?? currentStory.title,
    subtitle: parsed.subtitle ?? currentStory.subtitle,
    pages,
  };
}
