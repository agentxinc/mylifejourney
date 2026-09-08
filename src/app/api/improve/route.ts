import { NextRequest, NextResponse } from "next/server";
import { improveStory } from "@/lib/gemini";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { StoryPage } from "@/types";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rate = checkRateLimit(`improve:${ip}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSec) },
      }
    );
  }

  try {
    const {
      story,
      feedback,
    }: {
      story: { title: string; subtitle: string; pages: StoryPage[] };
      feedback: string;
    } = await request.json();

    if (!story || !feedback) {
      return NextResponse.json(
        { error: "Story and feedback are required" },
        { status: 400 }
      );
    }

    const improved = await improveStory(story, feedback);

    return NextResponse.json({
      ...improved,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Story improvement error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to improve story";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
