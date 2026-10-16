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
  withModelFallback,
  retryLog,
  chainConfigFromEnv,
} from "@/lib/generate-errors.mjs";
import { groqModel } from "@/lib/groq.mjs";
import { StoryPage } from "@/types";

// Keep above SERVER_TIMEOUT_MS (14.5s); see /api/generate.
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
      (signal) => withModelFallback((which, sig) => improveStory(story, feedback, sig, which), signal, {
        ...chainOpts(),
        groq: (sig) => improveStory(story, feedback, sig, "groq"),
        onRetry: retryLog("improve"),
      }),
      SERVER_TIMEOUT_MS
    );
    return NextResponse.json({
      ...improved,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const code = classifyError(error);
    logSafe("improve", code, error, {
      userTexts: [feedback, story.title, story.subtitle, ...story.pages.flatMap((p) => [p.title, p.narrative])],
    });
    return reply(errorPayload(code));
  }
}
