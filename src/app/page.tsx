"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import EventForm from "@/components/EventForm";
import EventTimeline from "@/components/EventTimeline";
import StoryPreview from "@/components/StoryPreview";
import { LifeEvent, GeneratedStory } from "@/types";
import { getRandomQuote } from "@/lib/quotes";
import { createSampleEvents } from "@/lib/sample-events";

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
  const [error, setError] = useState<string | null>(null);
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

  async function generateStory() {
    if (events.length === 0) return;
    setIsGenerating(true);
    setError(null);
    setStatusMessage("Creating your personalized storybook…");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate story");
      }

      const data: GeneratedStory = await res.json();
      setStory(data);
      setView("preview");
      setStatusMessage("Your storybook is ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatusMessage("");
    } finally {
      setIsGenerating(false);
    }
  }

  async function improveStory(feedback: string) {
    if (!story) return;
    setIsImproving(true);
    setError(null);
    setStatusMessage("Updating your story with your feedback…");

    try {
      const res = await fetch("/api/improve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ story, feedback }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to improve story");
      }

      const data: GeneratedStory = await res.json();
      setStory(data);
      setStatusMessage("Story updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStatusMessage("");
    } finally {
      setIsImproving(false);
    }
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
            role="alert"
            className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-6 flex items-start justify-between gap-3"
          >
            <p className="flex-1">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              className="text-red-500 hover:text-red-700 font-bold leading-none px-1"
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
                type="button"
                onClick={generateStory}
                className={`text-lg px-10 py-4 rounded-full font-semibold transition-all ${
                  events.length > 0
                    ? "btn-primary"
                    : "bg-indigo-100 text-indigo-400 border-2 border-dashed border-indigo-300 cursor-not-allowed"
                }`}
                disabled={isGenerating || events.length === 0}
                aria-busy={isGenerating}
              >
                {isGenerating
                  ? "Creating Your Storybook..."
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
