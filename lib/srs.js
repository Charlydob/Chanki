const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function defaultSrs() {
  return {
    bucket: "new",
    dueAt: Date.now(),
    reps: 0,
    repetitions: 0,
    intervalDays: 1,
    lapses: 0,
    ease: 2.3,
    lastReviewedAt: 0,
    lastRatings: [],
  };
}

function getIntervalDays(previous, now) {
  if (Number.isFinite(previous.intervalDays)) {
    return Math.max(1, Math.floor(previous.intervalDays));
  }
  const lastReviewedAt = previous.lastReviewedAt || now;
  const dueAt = previous.dueAt || now;
  const diffDays = Math.floor((dueAt - lastReviewedAt) / DAY);
  return Math.max(1, diffDays);
}

function scoreRating(rating) {
  switch (rating) {
    case "error":
      return 0;
    case "bad":
      return 0.3;
    case "good":
      return 0.7;
    case "easy":
      return 1;
    default:
      return 0.7;
  }
}

function computeEffectiveEase(ease, lastRatings) {
  const scores = (lastRatings || []).map((rating) => scoreRating(rating));
  const recent = scores.length
    ? scores.reduce((sum, value) => sum + value, 0) / scores.length
    : 0.7;
  return ease * 0.6 + (1.3 + recent * 1.2) * 0.4;
}

function getBucketByDueAt(dueAt, now) {
  const diff = Math.max(0, dueAt - now);
  if (diff <= 30 * MINUTE) return "immediate";
  if (diff <= 24 * HOUR) return "lt24h";
  if (diff <= 48 * HOUR) return "tomorrow";
  if (diff <= 7 * DAY) return "week";
  return "future";
}

export function computeNextSrs(previous, rating) {
  const now = Date.now();
  const base = { ...defaultSrs(), ...previous };
  const next = { ...base };
  const previousInterval = getIntervalDays(base, now);
  const lastRatings = Array.isArray(base.lastRatings) ? [...base.lastRatings] : [];
  lastRatings.push(rating);
  next.lastRatings = lastRatings.slice(-3);
  const effectiveEase = computeEffectiveEase(base.ease || 2.3, next.lastRatings);
  const currentRepetitions = base.repetitions ?? base.reps ?? 0;

  next.lastReviewedAt = now;

  if (rating === "error") {
    next.repetitions = 0;
    next.reps = 0;
    next.intervalDays = Math.max(1, Math.floor(previousInterval * 0.2));
    next.lapses = (base.lapses || 0) + 1;
    next.ease = Math.max(1.3, (base.ease || 2.3) - 0.3);
    next.dueAt = now + next.intervalDays * DAY;
    next.bucket = getBucketByDueAt(next.dueAt, now);
    return next;
  }

  if (rating === "bad") {
    next.repetitions = currentRepetitions + 1;
    next.reps = next.repetitions;
    next.intervalDays = Math.max(1, Math.floor(previousInterval * 1.2));
    next.ease = Math.max(1.3, (base.ease || 2.3) - 0.15);
    next.dueAt = now + next.intervalDays * DAY;
    next.bucket = getBucketByDueAt(next.dueAt, now);
    return next;
  }

  if (rating === "good") {
    next.repetitions = currentRepetitions + 1;
    next.reps = next.repetitions;
    next.intervalDays = Math.max(1, Math.floor(previousInterval * effectiveEase));
    next.ease = base.ease || 2.3;
    next.dueAt = now + next.intervalDays * DAY;
    next.bucket = getBucketByDueAt(next.dueAt, now);
    return next;
  }

  if (rating === "easy") {
    next.repetitions = currentRepetitions + 1;
    next.reps = next.repetitions;
    next.intervalDays = Math.max(1, Math.floor(previousInterval * (effectiveEase + 0.3)));
    next.ease = (base.ease || 2.3) + 0.1;
    next.dueAt = now + next.intervalDays * DAY;
    next.bucket = getBucketByDueAt(next.dueAt, now);
    return next;
  }

  return next;
}

export function buildQueueKey(dueAt, cardId) {
  return `${String(dueAt).padStart(13, "0")}_${cardId}`;
}
