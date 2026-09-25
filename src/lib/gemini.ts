import { GoogleGenAI } from "@google/genai";
import { LifeEvent, StoryPage } from "@/types";

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
  events: LifeEvent[]
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
      responseMimeType: "application/json",
    },
  });

  const text = response.text ?? "";
  const parsed = JSON.parse(text);

  // Map back the image URLs from original events
  const pages: StoryPage[] = parsed.pages.map(
    (page: StoryPage, index: number) => ({
      ...page,
      eventId: events[index]?.id ?? page.eventId,
      imageUrl: events[index]?.imageUrl ?? null,
    })
  );

  return {
    title: parsed.title,
    subtitle: parsed.subtitle,
    pages,
  };
}

export async function improveStory(
  currentStory: { title: string; subtitle: string; pages: StoryPage[] },
  feedback: string
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
      responseMimeType: "application/json",
    },
  });

  const text = response.text ?? "";
  const parsed = JSON.parse(text);

  // Preserve image URLs from current story
  const pages: StoryPage[] = parsed.pages.map(
    (page: StoryPage, index: number) => ({
      ...page,
      imageUrl: currentStory.pages[index]?.imageUrl ?? null,
    })
  );

  return {
    title: parsed.title,
    subtitle: parsed.subtitle,
    pages,
  };
}
