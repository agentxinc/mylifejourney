"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import EventForm from "@/components/EventForm";
import EventTimeline from "@/components/EventTimeline";
import StoryPreview from "@/components/StoryPreview";
import { LifeEvent, GeneratedStory } from "@/types";
import { getRandomQuote } from "@/lib/quotes";
import { createSampleEvents } from "@/lib/sample-events";
import {
  BUSY_WAIT_COPY,
  CLIENT_TIMEOUT_MS,
  DEFAULT_BUSY_WAIT_SEC,
  FIELD_HINTS,
  GENERATE_ERROR_COPY,
  IMPROVE_ERROR_COPY,
  SLOW_HINT_MS,
  classifyFetchFailure,
  isUsableStory,
  parseErrorResponse,
} from "@/lib/generate-errors.mjs";

type ClientError = ReturnType<typeof parseErrorResponse>;
type Flow = "generate" | "improve";
type ShownError = ClientError & {
  flow: Flow;
  id: number;
  waitSec?: number;
  eventTitle?: string;
  opened?: boolean;
};

/** Names the entry and field, since focus leaves the alert for the field. */
function fieldHint(field: "title" | "date", eventTitle: string | undefined, opened: boolean): string {
  const name = eventTitle?.trim();
  if (field === "date" && name) return `Add a date for \u201c${name}\u201d.`;
  if (field === "title") {
    return opened
      ? "Add a title for the entry now open in the form."
      : "Add a title to each entry, then try again.";
  }
  return FIELD_HINTS[field];
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

/** Test-only: forwards `?mock=` from the page URL; the server ignores it in Production. */
function apiPath(path: string): string {
  if (typeof window === "undefined") return path;
  const mock = new URLSearchParams(window.location.search).get("mock");
  return mock ? `${path}?mock=${encodeURIComponent(mock)}` : path;
}

function isOfflineMock(): boolean {
  if (typeof window === "undefined") return false;
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production") return false;
  return new URLSearchParams(window.location.search).get("mock") === "offline";
}

/**
 * POST JSON with a page-side timeout. Resolves to the parsed story, or
 * rejects with a ClientError. Never surfaces provider text.
 */
async function postForStory(path: string, payload: unknown): Promise<GeneratedStory> {
  if (isOfflineMock()) throw classifyFetchFailure(new TypeError("Failed to fetch"), false, false);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CLIENT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(apiPath(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw classifyFetchFailure(err, timedOut, navigator.onLine);
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      throw classifyFetchFailure(err, timedOut, navigator.onLine);
    }
    if (!res.ok) throw parseErrorResponse(res.status, text, res.headers.get("Retry-After"));
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw { code: "EMPTY" } as ClientError;
    }
    if (!isUsableStory(data)) throw { code: "EMPTY" } as ClientError;
    return data as GeneratedStory;
  } finally {
    clearTimeout(timer);
  }
}

function asClientError(err: unknown): ClientError {
  const e = err as Partial<ClientError> | null;
  return e && typeof e.code === "string" ? (e as ClientError) : { code: "SERVER" };
}

const STORAGE_KEY = "mylifejourney-events";

const PdfDocument = dynamic(() => import("@/components/PdfDocument"), {
  ssr: false,
});

function loadStoredEvents(): LifeEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is LifeEvent =>
        e &&
        typeof e.id === "string" &&
        typeof e.title === "string" &&
        typeof e.date === "string" &&
        typeof e.description === "string"
    );
  } catch {
    return [];
  }
}

export default function Home() {
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [editingEvent, setEditingEvent] = useState<LifeEvent | null>(null);
  const [story, setStory] = useState<GeneratedStory | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);
  const [busyWait, setBusyWait] = useState(0);
  const [showSlowHint, setShowSlowHint] = useState(false);
  const inFlight = useRef(false);
  const busyStreak = useRef(0);
  const errorSeq = useRef(0);
  const generateBtnRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const wasWaiting = useRef(false);
  const [view, setView] = useState<"input" | "preview">("input");
  const [quote, setQuote] = useState<{ text: string; author: string } | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    setQuote(getRandomQuote());
    setEvents(loadStoredEvents());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      // Persist without File blobs; imageUrl data URLs are kept when present
      const serializable = events.map(({ id, title, date, description, imageUrl }) => ({
        id,
        title,
        date,
        description,
        imageUrl: imageUrl ?? null,
      }));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    } catch {
      // Quota or private mode — non-fatal
    }
  }, [events, hydrated]);

  const addEvent = useCallback((event: LifeEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  const updateEvent = useCallback((event: LifeEvent) => {
    setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
    setEditingEvent(null);
  }, []);

  const removeEvent = useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setEditingEvent((current) => (current?.id === id ? null : current));
  }, []);

  const loadSampleEvents = useCallback(() => {
    setEditingEvent(null);
    setEvents(createSampleEvents());
    setStatusMessage(
      "Sample story loaded. Two demo events are on your timeline — you can Generate or edit them."
    );
  }, []);

  // BUSY countdown: tick once a second; announce only the end.
  useEffect(() => {
    if (busyWait > 0) {
      wasWaiting.current = true;
      const t = setTimeout(() => setBusyWait((n) => Math.max(0, n - 1)), 1000);
      return () => clearTimeout(t);
    }
    if (wasWaiting.current) {
      wasWaiting.current = false;
      setStatusMessage("You can try again now.");
    }
  }, [busyWait]);

  // Move focus to "Try again" once the request has finished. During a BUSY
  // countdown the button is aria-disabled (not disabled), so it keeps focus.
  useEffect(() => {
    if (!pendingFocus.current || isGenerating) return;
    const btn = generateBtnRef.current;
    if (btn && !btn.disabled) {
      btn.focus();
      pendingFocus.current = false;
    }
  }, [isGenerating, error]);

  function showError(err: unknown, flow: Flow) {
    const e = asClientError(err);
    errorSeq.current += 1;
    let waitSec: number | undefined;
    if (e.code === "BUSY") {
      busyStreak.current += 1;
      // Second BUSY in a row: hold the button so nobody hammers a capped API.
      if (busyStreak.current >= 2) waitSec = e.retryAfterSec ?? DEFAULT_BUSY_WAIT_SEC;
    } else {
      busyStreak.current = 0;
    }
    const target =
      flow === "generate" && e.code === "BAD_INPUT" && e.eventId
        ? events.find((ev) => ev.id === e.eventId)
        : undefined;
    // The alert announces the start of the wait once; ticks are visual only.
    setError({ ...e, flow, id: errorSeq.current, waitSec, eventTitle: target?.title, opened: !!target });
    if (waitSec) setBusyWait(waitSec);
    setStatusMessage("");
    if (flow === "generate" && e.code === "BAD_INPUT" && e.field) {
      if (target) setEditingEvent(target);
      // Let EventForm render the event, then bring the field on screen and focus it.
      setTimeout(() => {
        const el = document.getElementById(`event-${e.field}`);
        el?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        el?.focus({ preventScroll: true });
      }, 0);
    } else if (flow === "generate") {
      pendingFocus.current = true;
    }
  }

  async function runRequest(flow: Flow, run: () => Promise<void>): Promise<boolean> {
    // One request at a time: a ref updates synchronously, unlike `disabled`.
    if (inFlight.current || busyWait > 0) return false;
    inFlight.current = true;
    pendingFocus.current = false;
    setError(null);
    setShowSlowHint(false);
    const slowTimer = setTimeout(() => setShowSlowHint(true), SLOW_HINT_MS);
    try {
      await run();
      busyStreak.current = 0;
      return true;
    } catch (err) {
      showError(err, flow);
      return false;
    } finally {
      clearTimeout(slowTimer);
      setShowSlowHint(false);
      inFlight.current = false;
    }
  }

  async function generateStory() {
    // Check before touching state so a double-click can't reset the first request's UI.
    if (events.length === 0 || inFlight.current || busyWait > 0) return;
    setIsGenerating(true);
    setStatusMessage("Creating your personalized storybook…");
    await runRequest("generate", async () => {
      const data = await postForStory("/api/generate", { events });
      setStory(data);
      setView("preview");
      setStatusMessage("Your storybook is ready.");
    });
    setIsGenerating(false);
  }

  /** Resolves true on success so StoryPreview keeps the typed feedback on failure. */
  async function improveStory(feedback: string): Promise<boolean> {
    if (!story || inFlight.current || busyWait > 0) return false;
    setIsImproving(true);
    setStatusMessage("Updating your story with your feedback…");
    const ok = await runRequest("improve", async () => {
      // On any failure `story` is left as-is, so the original is unchanged.
      const data = await postForStory("/api/improve", { story, feedback });
      setStory(data);
      setStatusMessage("Story updated.");
    });
    setIsImproving(false);
    return ok;
  }

  async function downloadPdf() {
    if (!story) return;

    const { pdf } = await import("@react-pdf/renderer");
    const { default: PdfDoc } = await import("@/components/PdfDocument");
    const blob = await pdf(<PdfDoc story={story} />).toBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${story.title.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen">
      <header className="gradient-bg text-white py-6 px-4">
        <div className="max-w-5xl mx-auto flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">MyLifeJourney</h1>
            <p className="text-indigo-100 text-sm mt-0.5">
              Your personalized life storybook
            </p>
          </div>
          {story && (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Story views"
            >
              <button
                type="button"
                onClick={() => setView("input")}
                aria-pressed={view === "input"}
                className={`px-4 py-2 rounded-full text-sm font-medium transition ${
                  view === "input"
                    ? "bg-white text-indigo-600"
                    : "bg-white/20 text-white hover:bg-white/30"
                }`}
              >
                Edit Events
              </button>
              <button
                type="button"
                onClick={() => setView("preview")}
                aria-pressed={view === "preview"}
                className={`px-4 py-2 rounded-full text-sm font-medium transition ${
                  view === "preview"
                    ? "bg-white text-indigo-600"
                    : "bg-white/20 text-white hover:bg-white/30"
                }`}
              >
                View Story
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-8">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {statusMessage}
        </div>

        {error && (
          <div
            key={error.id}
            role="alert"
            className="bg-amber-50 border border-amber-300 text-amber-900 rounded-xl p-4 mb-6 flex items-start justify-between gap-3"
          >
            <span aria-hidden="true" className="leading-none">⚠️</span>
            <p className="flex-1">
              {error.code === "BUSY" && error.waitSec && busyWait > 0
                ? BUSY_WAIT_COPY
                : (error.flow === "improve" ? IMPROVE_ERROR_COPY : GENERATE_ERROR_COPY)[error.code]}
              {error.code === "BAD_INPUT" && error.field && (
                <> {fieldHint(error.field, error.eventTitle, !!error.opened)}</>
              )}
            </p>
            <button
              type="button"
              onClick={() => {
                // Dismissing also cancels the pending move to "Try again".
                pendingFocus.current = false;
                setError(null);
              }}
              aria-label="Dismiss error"
              className="text-amber-700 hover:text-amber-900 font-bold leading-none px-1"
            >
              ×
            </button>
          </div>
        )}

        {view === "input" ? (
          <>
            <div className="grid md:grid-cols-2 gap-8">
              <EventForm
                onAddEvent={addEvent}
                onUpdateEvent={updateEvent}
                editingEvent={editingEvent}
                onCancelEdit={() => setEditingEvent(null)}
              />
              <EventTimeline
                events={events}
                onRemoveEvent={removeEvent}
                onEditEvent={setEditingEvent}
                onLoadSample={loadSampleEvents}
                quote={quote}
              />
            </div>

            <div className="text-center mt-8">
              <button
                ref={generateBtnRef}
                type="button"
                onClick={generateStory}
                className={`text-lg px-10 py-4 rounded-full font-semibold transition-all ${
                  events.length > 0
                    ? `btn-primary${busyWait > 0 ? " opacity-60 cursor-not-allowed" : ""}`
                    : "bg-indigo-100 text-indigo-400 border-2 border-dashed border-indigo-300 cursor-not-allowed"
                }`}
                // aria-disabled during the countdown keeps focus on the button;
                // generateStory() ignores clicks while busyWait > 0.
                disabled={isGenerating || events.length === 0}
                aria-disabled={busyWait > 0 || undefined}
                aria-busy={isGenerating}
              >
                {isGenerating
                  ? "Creating Your Storybook..."
                  : busyWait > 0
                    ? `Try again in ${busyWait}s`
                    : error && error.flow === "generate"
                      ? "Try again"
                      : "Generate My Life Storybook"}
              </button>
              {events.length === 0 && (
                <p className="text-sm text-gray-400 mt-3">
                  Add at least one life event above, or try a sample story, to
                  generate your storybook
                </p>
              )}
              {isGenerating && (
                <p className="text-sm text-gray-400 mt-3" aria-hidden="true">
                  AI is crafting your personalized story...
                </p>
              )}
              <p className="text-sm text-gray-500 mt-2" aria-live="polite">
                {isGenerating && showSlowHint ? "Still writing your story…" : ""}
              </p>
            </div>
          </>
        ) : (
          story && (
            <StoryPreview
              story={story}
              onImprove={improveStory}
              onDownloadPdf={downloadPdf}
              isImproving={isImproving}
            />
          )
        )}
      </div>

      <footer className="text-center py-8 text-gray-400 text-sm">
        <p>MyLifeJourney — Powered by Google Gemini AI</p>
      </footer>
    </main>
  );
}
