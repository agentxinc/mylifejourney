import { NextRequest, NextResponse } from "next/server";
import { improveStory } from "@/lib/gemini";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  SERVER_TIMEOUT_MS,
  classifyError,
  errorPayload,
  getMock,
  logSafe,
  mockResponse,
  withTimeout,
  retryOnOverload,
  retryLog,
} from "@/lib/generate-errors.mjs";
import { StoryPage } from "@/types";

// Keep above SERVER_TIMEOUT_MS (25s); see /api/generate.
export const maxDuration = 60;

function reply(p: ReturnType<typeof errorPayload>) {
  return NextResponse.json(p.body, { status: p.status, headers: p.headers });
}

export async function POST(request: NextRequest) {
  const mock = getMock(request.url, process.env.VERCEL_ENV);
  if (mock) {
    const body = await request.json().catch(() => null);
    return mockResponse(mock, { events: body?.events });
  }

  const ip = getClientIp(request);
  const rate = checkRateLimit(`improve:${ip}`);
  if (!rate.allowed) {
    return reply(errorPayload("BUSY", { retryAfterSec: rate.retryAfterSec }));
  }

  let story: { title: string; subtitle: string; pages: StoryPage[] };
  let feedback: string;
  try {
    ({ story, feedback } = await request.json());
  } catch {
    return reply(errorPayload("BAD_INPUT"));
  }

  if (!story || !Array.isArray(story.pages) || typeof feedback !== "string" || !feedback.trim()) {
    return reply(errorPayload("BAD_INPUT", { field: "feedback" }));
  }

  try {
    const improved = await withTimeout(
      (signal) => retryOnOverload((s) => improveStory(story, feedback, s), signal, { onRetry: retryLog("improve") }),
      SERVER_TIMEOUT_MS
    );
    return NextResponse.json({
      ...improved,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const code = classifyError(error);
    logSafe("improve", code, error);
    return reply(errorPayload(code));
  }
}
