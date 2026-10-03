import { LifeEvent } from "@/types";

/**
 * Demo timeline for first-run cold start.
 * Dates are calendar `YYYY-MM-DD` (local-parse safe via `@/lib/dates`).
 */
export function createSampleEvents(): LifeEvent[] {
  return [
    {
      id: crypto.randomUUID(),
      title: "First day in a new city",
      date: "2018-08-15",
      description:
        "I stepped off the train with two suitcases and a job offer I barely believed. The apartment smelled like fresh paint. That night I ate takeout on the floor and felt terrified and free at the same time.",
      imageUrl: null,
    },
    {
      id: crypto.randomUUID(),
      title: "The birthday that changed the pace",
      date: "2020-01-15",
      description:
        "Friends filled a tiny kitchen with balloons and too much cake. Someone played our song on a phone speaker. I realized the people around the table were the home I had been looking for.",
      imageUrl: null,
    },
  ];
}
