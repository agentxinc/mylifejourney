import type { Metadata } from "next";
import Link from "next/link";
import {
  AGE_REQUIREMENT,
  GEMINI_TERMS_URL,
  GOOGLE_PRIVACY_URL,
} from "@/lib/privacy-copy.mjs";

export const metadata: Metadata = {
  title: "Privacy - MyLifeJourney",
  description: "How MyLifeJourney uses Google Gemini to write your story.",
};

const linkClass = "text-indigo-700 underline underline-offset-2 hover:text-indigo-900";

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-8">Privacy</h1>

      <section aria-labelledby="gemini-heading" className="mb-8">
        <h2 id="gemini-heading" className="text-xl font-semibold mb-3">
          How your story is written (Google Gemini)
        </h2>
        <p className="leading-relaxed">
          When you tap Generate or Improve, the events, descriptions and feedback you
          entered are sent to Google&apos;s Gemini API to write your story. We use
          Google&apos;s free tier. Under Google&apos;s terms, Google may use what you
          send, and the story it returns, to improve its products and AI models, and
          trained human reviewers may read it. Please don&apos;t include sensitive
          details like health information, financial or ID numbers, exact addresses,
          or anything about other people that they haven&apos;t agreed to share.
          Google&apos;s terms:{" "}
          <a href={GEMINI_TERMS_URL} className={linkClass} rel="noopener noreferrer">
            {GEMINI_TERMS_URL}
          </a>
          . Google&apos;s privacy policy:{" "}
          <a href={GOOGLE_PRIVACY_URL} className={linkClass} rel="noopener noreferrer">
            {GOOGLE_PRIVACY_URL}
          </a>
          .
        </p>
      </section>

      <section aria-labelledby="age-heading" className="mb-8">
        <h2 id="age-heading" className="text-xl font-semibold mb-3">
          Who can use mylifejourney
        </h2>
        <p className="leading-relaxed">{AGE_REQUIREMENT}</p>
      </section>

      <Link href="/" className={linkClass}>
        Back to MyLifeJourney
      </Link>
    </main>
  );
}
