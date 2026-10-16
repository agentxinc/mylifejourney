import { NextRequest, NextResponse } from "next/server";
import { generateStoryFromEvents } from "@/lib/gemini";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  SERVER_TIMEOUT_MS,
  classifyError,
  errorPayload,
  getMock,
  logSafe,
  mockResponse,
  validateEvents,
  withTimeout,
  withModelFallback,
  retryLog,
} from "@/lib/generate-errors.mjs";
import { stripEventImages } from "@/lib/strip-images.mjs";
import { LifeEvent } from "@/types";

// Keep above SERVER_TIMEOUT_MS (14.5s) so our JSON TIMEOUT always wins over a
// platform 504 page.
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
  const rate = checkRateLimit(`generate:${ip}`);
  if (!rate.allowed) {
    return reply(errorPayload("BUSY", { retryAfterSec: rate.retryAfterSec }));
  }

  let events: LifeEvent[];
  try {
    ({ events } = await request.json());
    // Old cached clients may still send photos: drop them, don't 400.
    events = stripEventImages(events) as LifeEvent[];
  } catch {
    return reply(errorPayload("BAD_INPUT"));
  }

  const invalid = validateEvents(events);
  if (invalid) return reply(errorPayload("BAD_INPUT", invalid));

  try {
    const story = await withTimeout(
      (signal) => withModelFallback((which, sig) => generateStoryFromEvents(events, sig, which), signal, { onRetry: retryLog("generate") }),
      SERVER_TIMEOUT_MS
    );
    return NextResponse.json({
      ...story,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const code = classifyError(error);
    logSafe("generate", code, error, { userTexts: events.flatMap((e) => [e.title, e.description]) });
    return reply(errorPayload(code));
  }
}
