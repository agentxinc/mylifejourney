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
  chainConfigFromEnv,
} from "@/lib/generate-errors.mjs";
import { groqModel } from "@/lib/groq.mjs";
import { LifeEvent } from "@/types";

// Keep above SERVER_TIMEOUT_MS (14.5s) so our JSON TIMEOUT always wins over a
// platform 504 page.
export const maxDuration = 60;

/** Env-driven provider order + clamped step timeouts; default = Gemini primary -> lite only. */
function chainOpts() {
  const cfg = chainConfigFromEnv(process.env);
  return {
    // Default env: no order passed, so behavior and log line are exactly as before.
    ...(cfg.groqEnabled || process.env.MLJ_PROVIDER_ORDER?.trim() ? { order: cfg.order } : {}),
    primaryMs: cfg.stepMs["gemini-primary"],
    fallbackMs: cfg.stepMs["gemini-lite"],
    groqMs: cfg.stepMs.groq,
    models: {
      "gemini-primary": process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash",
      "gemini-lite": process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.5-flash-lite",
      groq: groqModel(process.env),
    },
  };
}

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
      (signal) => withModelFallback((which, sig) => generateStoryFromEvents(events, sig, which), signal, {
        ...chainOpts(),
        groq: (sig) => generateStoryFromEvents(events, sig, "groq"),
        onRetry: retryLog("generate"),
      }),
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
