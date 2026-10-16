# MyLifeJourney

Next.js app that turns life events into a storybook. `npm run dev`, `npm test`.

## Environment

See `.env.example` for every variable. Summary:

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | (required) | |
| `GEMINI_MODEL` | `gemini-3.5-flash` | primary |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | used once on a 503 / primary timeout |
| `MLJ_PRIMARY_TIMEOUT_MS` | `10000` | clamped to remaining budget |
| `MLJ_FALLBACK_TIMEOUT_MS` | `4000` | clamped to remaining budget |
| `MLJ_FALLBACK_PROVIDER` | (unset) | `groq` enables Groq **only if** `GROQ_API_KEY` is also set |
| `GROQ_API_KEY` | (unset) | encrypted env var; never logged |
| `MLJ_GROQ_MODEL` | `openai/gpt-oss-120b` | |
| `MLJ_GROQ_TIMEOUT_MS` | `4000` | clamped to remaining budget |
| `MLJ_PROVIDER_ORDER` | `gemini-primary,gemini-lite` (+`,groq` when enabled) | e.g. `groq,gemini-primary` |

**Budget.** `/api/generate` and `/api/improve` always answer within 14.5s. Each
step gets `min(its timeout, budget left)`; a step with under 1s left is skipped.
Only overload/timeout moves on to the next provider (Gemini 503; Groq 429/5xx).
Nothing is retried on the same provider; if all fail, the route returns BUSY.

**Gemini-first order:** Groq realistically helps only after a *fast* 503;
after a 10s primary timeout + 4s lite, ~0.3s is left and Groq is skipped.

**Groq-primary preset:** `MLJ_PROVIDER_ORDER=groq,gemini-primary`,
`MLJ_GROQ_TIMEOUT_MS=7000` -> Groq up to 7s, then gemini-3.5-flash on the ~7.2s left.

**Logs.** One line per fallback (`retry: "gemini-fallback"` by default,
`"provider-chain"` with a custom order/Groq, including `answeredBy:
"<provider>:<model>"`). Never user text, never keys.

**Order validation.** Exactly `groq` means Groq only (one warning log line);
if Groq is disabled the default order is used. For any other value: unknown
names and duplicates are dropped (unknown names are warned once), and if
`gemini-primary` is missing it is appended (warned). If nothing valid remains
the default order is used. A Groq 401/403 (`GROQ_AUTH`, status only) or a
malformed 200 body moves on to the next provider, or BUSY if Groq is last.
