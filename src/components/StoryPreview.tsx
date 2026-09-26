"use client";

import { useState } from "react";
import { GeneratedStory } from "@/types";
import { formatCalendarDate } from "@/lib/dates";

interface StoryPreviewProps {
  story: GeneratedStory;
  onImprove: (feedback: string) => void;
  onDownloadPdf: () => void;
  isImproving: boolean;
}

export default function StoryPreview({
  story,
  onImprove,
  onDownloadPdf,
  isImproving,
}: StoryPreviewProps) {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);

  function handleSubmitFeedback(e: React.FormEvent) {
    e.preventDefault();
    if (!feedback.trim()) return;
    onImprove(feedback);
    setFeedback("");
    setShowFeedback(false);
  }

  return (
    <div className="space-y-6">
      <div className="text-center py-8 font-story">
        <h2 className="text-3xl font-bold text-gray-800">{story.title}</h2>
        <p className="text-lg text-gray-500 mt-2 italic">{story.subtitle}</p>
      </div>

      {story.pages.map((page) => (
        <article
          key={page.pageNumber}
          className="slambook-page rounded-xl p-8 max-w-2xl mx-auto animate-fade-in-up"
        >
          <div className="pl-10">
            <p className="text-xs font-medium text-indigo-500 mb-2 font-sans">
              Chapter {page.pageNumber}
            </p>
            <h3 className="text-xl font-bold text-gray-800 mb-1">{page.title}</h3>
            <p className="text-sm text of-gray-400 mb-4 font-sans">
              {formatCalendarDate(page.date)}
            </p>

            {page.imageUrl && (
              <div className="mb-4">
                <img
                  src={page.imageUrl}
                  alt=""
                  className="w-full max-h-64 object-cover rounded-xl shadow-md"
                />
              </div>
            )}

            <div className="text-gray-700 leading-relaxed whitespace-pre-line">
              {page.narrative}
            </div>
          </div>
        </article>
      ))}

      <div className="flex flex-col items-center gap-4 pt-4">
        <div className="flex gap-3 flex-wrap justify-center">
          <button type="button" onClick={onDownloadPdf} className="btn-primary">
            Download as PDF
          </button>
          <button
            type="button"
            onClick={() => setShowFeedback(!showFeedback)}
            className="btn-secondary"
            aria-expanded={showFeedback}
            aria-controls="story-feedback-form"
          >
            Suggest Improvements
          </button>
        </div>

        {showFeedback && (
          <form
            id="story-feedback-form"
            onSubmit={handleSubmitFeedback}
            className="w-full max-w-lg bg-white rounded-xl p-5 card-shadow"
          >
            <label
              htmlFor="story-feedback"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              What would you like to change?
            </label>
            <textarea
              id="story-feedback"
              name="feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g., Make the tone more humorous, add more detail to chapter 2, change the title..."
              rows={3}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none transition resize-none mb-3"
              required
            />
            <button
              type="submit"
              className="btn-primary w-full text-center"
              disabled={isImproving}
              aria-busy={isImproving}
            >
              {isImproving ? "Regenerating..." : "Regenerate with Changes"}
            </button>
          </form>
        )}

        <aside className="mt-6 w-full max-w-md border-t border-gray-200 pt-6 text-center">
          <span className="inline-block bg-gray-100 text-gray-600 text-xs font-semibold tracking-wide px-3 py-1 rounded-full mb-2">
            Coming soon
          </span>
          <p className="text-sm text-gray-500">
            Video storybook with narration and music — not available yet.
          </p>
        </aside>
      </div>
    </div>
  );
}
