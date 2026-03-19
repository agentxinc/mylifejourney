"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import EventForm from "@/components/EventForm";
import EventTimeline from "@/components/EventTimeline";
import StoryPreview from "@/components/StoryPreview";
import { LifeEvent, GeneratedStory } from "@/types";
import { getRandomQuote } from "@/lib/quotes";

const PdfDocument = dynamic(() => import("@/components/PdfDocument"), {
  ssr: false,
});

export default function Home() {
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [story, setStory] = useState<GeneratedStory | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"input" | "preview">("input");
  const [quote, setQuote] = useState<{ text: string; author: string } | null>(null);

  useEffect(() => {
    setQuote(getRandomQuote());
  }, []);

  const addEvent = useCallback((event: LifeEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  const removeEvent = useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
  }, []);

  async function generateStory() {
    if (events.length === 0) return;
    setIsGenerating(true);
    setError(null);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsGenerating(false);
    }
  }

  async function improveStory(feedback: string) {
    if (!story) return;
    setIsImproving(true);
    setError(null);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsImproving(false);
    }
  }

  async function downloadPdf() {
    if (!story) return;

    // Dynamic import for client-side PDF generation
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
      {/* Quote Banner */}
      {quote && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-100 py-3 px-4 text-center">
          <p className="text-gray-700 italic text-sm max-w-2xl mx-auto">
            &ldquo;{quote.text}&rdquo;
          </p>
          <p className="text-xs text-gray-400 mt-1">&mdash; {quote.author}</p>
        </div>
      )}

      {/* Header */}
      <header className="gradient-bg text-white py-6 px-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              MyLifeJourney
            </h1>
            <p className="text-indigo-100 text-sm mt-0.5">
              Your personalized life storybook
            </p>
          </div>
          {story && (
            <div className="flex gap-2">
              <button
                onClick={() => setView("input")}
                className={`px-4 py-2 rounded-full text-sm font-medium transition ${
                  view === "input"
                    ? "bg-white text-indigo-600"
                    : "bg-white/20 text-white hover:bg-white/30"
                }`}
              >
                Edit Events
              </button>
              <button
                onClick={() => setView("preview")}
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
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 mb-6">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-2 text-red-500 hover:text-red-700 font-bold"
            >
              x
            </button>
          </div>
        )}

        {view === "input" ? (
          <>
            <div className="grid md:grid-cols-2 gap-8">
              <EventForm onAddEvent={addEvent} />
              <EventTimeline events={events} onRemoveEvent={removeEvent} />
            </div>

            <div className="text-center mt-8">
              <button
                onClick={generateStory}
                className={`text-lg px-10 py-4 rounded-full font-semibold transition-all ${
                  events.length > 0
                    ? "btn-primary"
                    : "bg-gray-200 text-gray-400 cursor-not-allowed"
                }`}
                disabled={isGenerating || events.length === 0}
              >
                {isGenerating
                  ? "Creating Your Storybook..."
                  : "Generate My Life Storybook"}
              </button>
              {events.length === 0 && (
                <p className="text-sm text-gray-400 mt-3">
                  Add at least one life event above to generate your storybook
                </p>
              )}
              {isGenerating && (
                <p className="text-sm text-gray-400 mt-3">
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

      {/* Footer */}
      <footer className="text-center py-8 text-gray-400 text-sm">
        <p>MyLifeJourney &mdash; Powered by Google Gemini AI</p>
      </footer>
    </main>
  );
}
