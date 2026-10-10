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
  retryOnOverload,
  retryLog,
} from "@/lib/generate-errors.mjs";
import { LifeEvent } from "@/types";

// Keep above SERVER_TIMEOUT_MS (25s) so our JSON TIMEOUT always wins over a
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
  } catch {
    return reply(errorPayload("BAD_INPUT"));
  }

  const invalid = validateEvents(events);
  if (invalid) return reply(errorPayload("BAD_INPUT", invalid));

  try {
    const story = await withTimeout(
      (signal) => retryOnOverload((s) => generateStoryFromEvents(events, s), signal, { onRetry: retryLog("generate") }),
      SERVER_TIMEOUT_MS
    );
    return NextResponse.json({
      ...story,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const code = classifyError(error);
    logSafe("generate", code, error);
    return reply(errorPayload(code));
  }
}
