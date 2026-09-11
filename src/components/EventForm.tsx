"use client";

import { useState } from "react";
import exifr from "exifr";
import { LifeEvent } from "@/types";

interface EventFormProps {
  onAddEvent: (event: LifeEvent) => void;
}

export default function EventForm({ onAddEvent }: EventFormProps) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [dateSource, setDateSource] = useState<"manual" | "exif">("manual");

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);

    try {
      const exifData = await exifr.parse(file, [
        "DateTimeOriginal",
        "CreateDate",
        "ModifyDate",
      ]);
      const exifDate =
        exifData?.DateTimeOriginal ||
        exifData?.CreateDate ||
        exifData?.ModifyDate;
      if (exifDate && exifDate instanceof Date) {
        const formatted = exifDate.toISOString().split("T")[0];
        setDate(formatted);
        setDateSource("exif");
      }
    } catch {
      // No EXIF data available — that's fine
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !date || !description) return;

    const event: LifeEvent = {
      id: crypto.randomUUID(),
      title,
      date,
      description,
      imageUrl: imagePreview,
    };

    onAddEvent(event);
    setTitle("");
    setDate("");
    setDescription("");
    setImagePreview(null);
    setDateSource("manual");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-2xl p-6 card-shadow"
    >
      <h2 className="text-xl font-bold mb-4 text-indigo-500">
        Add a Life Event
      </h2>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="event-title"
            className="block text-sm font-medium mb-1 text-gray-700"
          >
            Event Title
          </label>
          <input
            id="event-title"
            name="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., First Day of School"
            autoComplete="off"
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none transition"
            required
          />
        </div>

        <div>
          <label
            htmlFor="event-date"
            className="block text-sm font-medium mb-1 text-gray-700"
          >
            Date
          </label>
          <input
            id="event-date"
            name="date"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setDateSource("manual");
            }}
            className={`w-full px-4 py-2.5 rounded-xl border outline-none transition ${
              dateSource === "exif"
                ? "border-green-300 bg-green-50 focus:border-green-400 focus:ring-2 focus:ring-green-100"
                : "border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            }`}
            required
          />
          {dateSource === "exif" && (
            <p id="event-date-hint" className="text-xs text-green-600 mt-1">
              Date auto-filled from photo metadata
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="event-description"
            className="block text-sm font-medium mb-1 text-gray-700"
          >
            Description
          </label>
          <textarea
            id="event-description"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe this moment... What happened? How did you feel?"
            rows={3}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none transition resize-none"
            required
          />
        </div>

        <div>
          <label
            htmlFor="event-photo"
            className="block text-sm font-medium mb-1 text-gray-700"
          >
            Photo (optional)
          </label>
          <input
            id="event-photo"
            name="photo"
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-600 hover:file:bg-indigo-100 file:cursor-pointer"
          />
          {imagePreview && (
            <div className="mt-2">
              <img
                src={imagePreview}
                alt="Selected event preview"
                className="w-32 h-32 object-cover rounded-xl"
              />
            </div>
          )}
        </div>

        <button type="submit" className="btn-primary w-full text-center">
          + Add Event
        </button>
      </div>
    </form>
  );
}
