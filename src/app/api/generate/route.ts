import { NextRequest, NextResponse } from "next/server";
import { generateStoryFromEvents } from "@/lib/gemini";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { LifeEvent } from "@/types";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rate = checkRateLimit(`generate:${ip}`);
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
    const { events }: { events: LifeEvent[] } = await request.json();

    if (!events || events.length === 0) {
      return NextResponse.json(
        { error: "No events provided" },
        { status: 400 }
      );
    }

    const story = await generateStoryFromEvents(events);

    return NextResponse.json({
      ...story,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Story generation error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate story";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
