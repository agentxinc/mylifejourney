import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { LifeEvent, StoryPage } from "@/types";
import { BadReplyError, describeResponse, parseStoryText } from "@/lib/parse-story.mjs";

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

function getModel(): string {
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
  abortSignal?: AbortSignal
): Promise<{ title: string; subtitle: string; pages: StoryPage[] }> {
  const ai = getClient();

  const eventDescriptions = events
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map(
      (e, i) =>
        `Event ${i + 1}: "${e.title}" on ${e.date}. Description: ${e.description}`
    )
    .join("\n");

  const prompt = `You are a creative storyteller creating a personalized life journey slambook.
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

  const response = await ai.models.generateContent({
    model: getModel(),
    contents: prompt,
    config: {
      ...STORY_CONFIG,
      // Cancels the HTTP call at our cutoff. Per the SDK, the provider may
      // still bill work already started; this stops us waiting on it.
      abortSignal,
    },
  });

  const parsed = parseStoryJson("generate", response);

  // Map back the image URLs from original events
  const pages: StoryPage[] = parsed.pages.map(
    (page: StoryPage, index: number) => ({
      ...page,
      eventId: events[index]?.id ?? page.eventId,
      imageUrl: events[index]?.imageUrl ?? null,
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
  abortSignal?: AbortSignal
): Promise<{ title: string; subtitle: string; pages: StoryPage[] }> {
  const ai = getClient();

  const prompt = `You are a creative storyteller improving a personalized life journey slambook.

Here is the current storybook:
${JSON.stringify(currentStory, null, 2)}

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
      "imageUrl": null,
      "pageNumber": 1
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model: getModel(),
    contents: prompt,
    config: {
      ...STORY_CONFIG,
      // Cancels the HTTP call at our cutoff. Per the SDK, the provider may
      // still bill work already started; this stops us waiting on it.
      abortSignal,
    },
  });

  const parsed = parseStoryJson("improve", response);

  // Preserve image URLs from current story
  const pages: StoryPage[] = parsed.pages.map(
    (page: StoryPage, index: number) => ({
      ...page,
      imageUrl: currentStory.pages[index]?.imageUrl ?? null,
    })
  );

  return {
    title: parsed.title ?? currentStory.title,
    subtitle: parsed.subtitle ?? currentStory.subtitle,
    pages,
  };
}
