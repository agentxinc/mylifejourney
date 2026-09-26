/**
 * Calendar dates are stored as `YYYY-MM-DD` (HTML date inputs / EXIF day).
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, so US timezones show the
 * previous calendar day. Parse and format as local calendar dates instead.
 */

const CALENDAR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD` as local midnight; fall back to Date for full timestamps. */
export function parseCalendarDate(isoDate: string): Date {
  const m = CALENDAR_RE.exec(isoDate.trim());
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(isoDate);
}

/** Format a calendar date string for display (timeline, story, PDF). */
export function formatCalendarDate(
  isoDate: string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
  }
): string {
  return parseCalendarDate(isoDate).toLocaleDateString("en-US", options);
}

/** Local `YYYY-MM-DD` for `<input type="date">` (avoids `toISOString` UTC shift). */
export function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}
