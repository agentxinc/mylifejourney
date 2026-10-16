// @ts-check
/**
 * Optional Groq fallback (OpenAI-compatible chat completions via plain fetch).
 * Only used when MLJ_FALLBACK_PROVIDER=groq AND GROQ_API_KEY is set; see
 * chainConfigFromEnv in generate-errors.mjs. The key is only ever sent in the
 * Authorization header; it is never logged or put in an error message.
 */

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/** @param {Record<string, string | undefined>} env */
export function groqModel(env) {
  return env.MLJ_GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
}

/**
 * Send one prompt, return the reply text + finishReason in Gemini's shape so
 * the same parser/guards apply. Non-2xx throws `{ status }` with a fixed
 * message (the provider body is never read into logs). No retries here.
 * @param {string} prompt
 * @param {AbortSignal} signal
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ text: string, candidates: { finishReason: string }[] }>}
 */
export async function groqGenerate(prompt, signal, opts = {}) {
  const env = opts.env ?? process.env;
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw Object.assign(new Error("GROQ_API_KEY is not set"), { name: "ConfigError" });
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(GROQ_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: groqModel(env),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_completion_tokens: 16384,
    }),
  });
  if (!res.ok) {
    const status = res.status;
    const code =
      status === 401 || status === 403 ? "GROQ_AUTH" : status === 429 ? "RESOURCE_EXHAUSTED" : status >= 500 ? "UNAVAILABLE" : "INTERNAL";
    throw Object.assign(new Error(`${code}: groq HTTP ${status}`), { status });
  }
  // Non-JSON / malformed 200 -> retryable provider failure (502), not SERVER.
  const badBody = () => Object.assign(new Error("UNAVAILABLE: groq malformed body"), { status: 502 });
  let data;
  try {
    data = await res.json();
  } catch {
    throw badBody();
  }
  const choice = data?.choices?.[0];
  if (!choice || typeof choice?.message?.content !== "string") throw badBody();
  const finish = choice?.finish_reason;
  return {
    text: typeof choice?.message?.content === "string" ? choice.message.content : "",
    candidates: [{ finishReason: finish === "stop" || finish == null ? "STOP" : String(finish).toUpperCase() }],
  };
}
