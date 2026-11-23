// Fair use for the beta: per-user requests per minute and per day across
// /dictate, /rewrite and /check, counted atomically in Postgres by
// public.consume_usage (see the v2 migration).

export interface Limits {
  perMinute: number;
  perDay: number;
}

export const DEFAULT_LIMITS: Limits = { perMinute: 20, perDay: 300 };
export const PLAN = "beta";
/** Audio up to 6 minutes (a few seconds of slack for the client's timer). */
export const MAX_AUDIO_SEC = 6 * 60 + 5;

export type UsageDecision =
  | { allowed: true; today: number }
  | {
      allowed: false;
      code: "rate_limited" | "quota";
      today: number;
      retry_after_sec: number;
    };

export class LimitError extends Error {
  constructor(
    readonly code: "rate_limited" | "quota",
    readonly retryAfterSec: number,
    message?: string,
  ) {
    super(
      message ??
        (code === "quota"
          ? "You've reached today's limit. It resets at midnight UTC."
          : "That's a lot of requests in a minute. Try again in a moment."),
    );
  }
}

/** Feedback isn't counted in the limits, but is capped per hour. */
export const FEEDBACK_PER_HOUR = 30;

/**
 * Seconds until another feedback is allowed, given the times of this
 * user's feedback in the last hour; 0 when it's allowed now.
 */
export function feedbackRetryAfter(
  recent: string[],
  now = Date.now(),
  cap = FEEDBACK_PER_HOUR,
): number {
  const times = recent
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t) && t > now - 3_600_000)
    .sort((a, b) => a - b);
  if (times.length < cap) return 0;
  // The oldest of the last `cap` leaves the window first.
  const oldest = times[times.length - cap];
  return Math.max(1, Math.ceil((oldest + 3_600_000 - now) / 1000));
}

/** Limits from env (PF_PER_MINUTE, PF_PER_DAY), else the beta defaults. */
export function limitsFrom(env: {
  get(name: string): string | undefined;
}): Limits {
  const n = (name: string, fallback: number) => {
    const v = Number(env.get(name));
    return Number.isInteger(v) && v > 0 ? v : fallback;
  };
  return {
    perMinute: n("PF_PER_MINUTE", DEFAULT_LIMITS.perMinute),
    perDay: n("PF_PER_DAY", DEFAULT_LIMITS.perDay),
  };
}

/** Reads consume_usage's JSON. Anything unexpected lets the request through. */
export function parseUsageDecision(raw: unknown): UsageDecision {
  const r = (Array.isArray(raw) ? raw[0] : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const today = typeof r?.today === "number" ? r.today : 0;
  if (!r || r.allowed !== false) return { allowed: true, today };
  const code = r.code === "quota" ? "quota" : "rate_limited";
  const retry = Number(r.retry_after_sec);
  return {
    allowed: false,
    code,
    today,
    retry_after_sec:
      Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60,
  };
}

/** Today's date in UTC, the day the counter is keyed by. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Seconds of audio in a PCM WAV, from its header; undefined if not a WAV.
 * `totalBytes` is the file's size when `bytes` holds only its start.
 */
export function wavSeconds(
  bytes: Uint8Array,
  totalBytes = bytes.length,
): number | undefined {
  if (bytes.length < 44) return undefined;
  const tag = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk the chunks: "fmt " gives the byte rate, "data" the length.
  let byteRate = 0;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    if (id === "fmt " && o + 16 <= bytes.length)
      byteRate = view.getUint32(o + 16, true);
    if (id === "data") {
      if (!byteRate) return undefined;
      // Streaming writers leave the size at 0 or 0xFFFFFFFF; use what's there.
      const available = totalBytes - o - 8;
      const len = size === 0 || size === 0xffffffff ? available : size;
      return Math.max(0, Math.min(len, available)) / byteRate;
    }
    o += 8 + size + (size % 2);
  }
  return undefined;
}
