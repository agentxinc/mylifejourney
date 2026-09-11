"use client";

import { LifeEvent } from "@/types";

interface EventTimelineProps {
  events: LifeEvent[];
  onRemoveEvent: (id: string) => void;
  onEditEvent?: (event: LifeEvent) => void;
  quote?: { text: string; author: string } | null;
}

export default function EventTimeline({
  events,
  onRemoveEvent,
  onEditEvent,
  quote,
}: EventTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <div className="text-5xl mb-4" aria-hidden="true">
          📖
        </div>
        <p className="text-lg text-gray-500">Your life events will appear here</p>
        <p className="text-sm mt-1">Add your first event to get started</p>
        {quote && (
          <blockquote className="mt-8 max-w-sm mx-auto px-4">
            <p className="font-story text-sm italic text-indigo-400/90 leading-relaxed">
              “{quote.text}”
            </p>
            <footer className="text-xs text-gray-400 mt-2">
              — {quote.author}
            </footer>
          </blockquote>
        )}
      </div>
    );
  }

  const sorted = [...events].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  return (
    <div className="space-y-0 relative">
      <h2 className="text-xl font-bold mb-6 text-indigo-500">
        Your Timeline ({events.length} event{events.length !== 1 ? "s" : ""})
      </h2>
      <div className="relative pl-8">
        <div
          className="absolute left-3 top-0 bottom-0 w-0.5"
          style={{
            background: "linear-gradient(to bottom, #667eea, #764ba2)",
          }}
          aria-hidden="true"
        />
        {sorted.map((event, index) => (
          <div
            key={event.id}
            className="relative mb-6 animate-fade-in-up"
            style={{ animationDelay: `${index * 0.1}s` }}
          >
            <div className="timeline-dot absolute -left-5 top-2" aria-hidden="true" />
            <div className="bg-white rounded-xl p-4 card-shadow ml-4">
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-indigo-500 mb-1">
                    {new Date(event.date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </p>
                  <h3 className="font-bold text-gray-800">{event.title}</h3>
                  <p className="text-sm text-gray-600 mt-1 line-clamp-2">
                    {event.description}
                  </p>
                </div>
                {event.imageUrl && (
                  <img
                    src={event.imageUrl}
                    alt=""
                    className="w-16 h-16 object-cover rounded-lg ml-3 flex-shrink-0"
                  />
                )}
              </div>
              <div className="flex gap-3 mt-2">
                {onEditEvent && (
                  <button
                    type="button"
                    onClick={() => onEditEvent(event)}
                    className="text-xs text-indigo-500 hover:text-indigo-700 transition"
                    aria-label={`Edit event ${event.title}`}
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveEvent(event.id)}
                  className="text-xs text-red-400 hover:text-red-600 transition"
                  aria-label={`Remove event ${event.title}`}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
