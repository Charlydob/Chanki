const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function defaultSrs() {
  const now = Date.now();
  return {
    bucket: "new",
    dueAt: now,
    nextReviewAt: now,
    reps: 0,
    repetitions: 0,
    reviewCount: 0,
    intervalDays: 0,
    interval: 0,
    lapses: 0,
    mistakes: 0,
    ease: 2.3,
    reviewScore: 0,
    learningStep: 0,
    streak: 0,
    lastReviewedAt: 0,
    lastRatings: [],
  };
}

export function normalizeSrs(previous = {}, createdAt = Date.now()) {
  const now = Date.now();
  const raw = previous || {};
  const base = { ...defaultSrs(), ...raw };
  const nextReviewAt = Number(raw.nextReviewAt ?? raw.dueAt ?? createdAt ?? now);
  const reviewCount = Number(raw.reviewCount ?? raw.repetitions ?? raw.reps ?? 0) || 0;
  const interval = Number(raw.interval ?? raw.intervalDays ?? 0) || 0;
  const mistakes = Number(raw.mistakes ?? raw.lapses ?? 0) || 0;
  return {
    ...base,
    bucket: base.bucket || "new",
    dueAt: nextReviewAt,
    nextReviewAt,
    reps: reviewCount,
    repetitions: reviewCount,
    reviewCount,
    intervalDays: interval,
    interval,
    mistakes,
    lapses: mistakes,
    ease: Math.max(1.3, Number(base.ease || 2.3)),
    reviewScore: Number(raw.reviewScore ?? Math.max(0, reviewCount - mistakes)) || 0,
    lastReviewedAt: Number(base.lastReviewedAt || 0) || 0,
    lastRatings: Array.isArray(base.lastRatings) ? base.lastRatings.slice(-3) : [],
  };
}

function getIntervalDays(previous, now) {
  if (Number.isFinite(previous.interval)) {
    return Math.max(1, Math.floor(previous.interval));
  }
  if (Number.isFinite(previous.intervalDays)) {
    return Math.max(1, Math.floor(previous.intervalDays));
  }
  const lastReviewedAt = previous.lastReviewedAt || now;
  const dueAt = previous.nextReviewAt || previous.dueAt || now;
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

function applySchedule(next, now, intervalDays, dueAt) {
  next.intervalDays = intervalDays;
  next.interval = intervalDays;
  next.dueAt = dueAt;
  next.nextReviewAt = dueAt;
  next.bucket = getBucketByDueAt(dueAt, now);
}

export function computeNextSrs(previous, rating) {
  const now = Date.now();
  const base = normalizeSrs(previous, now);
  const next = { ...base };
  const previousInterval = getIntervalDays(base, now);
  const lastRatings = Array.isArray(base.lastRatings) ? [...base.lastRatings] : [];
  lastRatings.push(rating);
  next.lastRatings = lastRatings.slice(-3);
  const effectiveEase = computeEffectiveEase(base.ease || 2.3, next.lastRatings);
  const currentRepetitions = base.reviewCount ?? base.repetitions ?? base.reps ?? 0;

  next.lastReviewedAt = now;
  next.reviewCount = currentRepetitions + 1;
  next.repetitions = next.reviewCount;
  next.reps = next.reviewCount;

  if (rating === "error") {
    next.reviewScore = Math.max(0, (base.reviewScore || 0) - 1);
    next.mistakes = (base.mistakes || 0) + 1;
    next.lapses = next.mistakes;
    next.ease = Math.max(1.3, (base.ease || 2.3) - 0.2);
    next.learningStep = 0;
    next.streak = 0;
    applySchedule(next, now, 0, now + 20 * MINUTE);
    console.info("[chanki:review-schedule]", { rating, nextReviewAt: next.nextReviewAt, interval: next.interval, ease: next.ease, reviewScore: next.reviewScore, mistakes: next.mistakes });
    return next;
  }

  if (rating === "bad") {
    next.reviewScore = Math.max(0, (base.reviewScore || 0) + 0.3);
    next.ease = Math.max(1.3, (base.ease || 2.3) - 0.15);
    next.streak = 0;
    applySchedule(next, now, Math.max(1, Math.floor(previousInterval * 1.2)), now + Math.max(1, Math.floor(previousInterval * 1.2)) * DAY);
    console.info("[chanki:review-schedule]", { rating, nextReviewAt: next.nextReviewAt, interval: next.interval, ease: next.ease, reviewScore: next.reviewScore, mistakes: next.mistakes });
    return next;
  }

  if (rating === "good") {
    const intervalDays = currentRepetitions <= 0
      ? 1
      : Math.max(1, Math.floor(previousInterval * Math.max(1.4, effectiveEase)));
    next.reviewScore = (base.reviewScore || 0) + 1;
    next.ease = base.ease || 2.3;
    next.streak = (base.streak || 0) + 1;
    applySchedule(next, now, intervalDays, now + intervalDays * DAY);
    console.info("[chanki:review-schedule]", { rating, nextReviewAt: next.nextReviewAt, interval: next.interval, ease: next.ease, reviewScore: next.reviewScore, mistakes: next.mistakes });
    return next;
  }

  if (rating === "easy") {
    const intervalDays = currentRepetitions <= 0
      ? 3
      : Math.max(2, Math.floor(previousInterval * (effectiveEase + 0.8)));
    next.reviewScore = (base.reviewScore || 0) + 2;
    next.ease = (base.ease || 2.3) + 0.1;
    next.streak = (base.streak || 0) + 1;
    applySchedule(next, now, intervalDays, now + intervalDays * DAY);
    console.info("[chanki:review-schedule]", { rating, nextReviewAt: next.nextReviewAt, interval: next.interval, ease: next.ease, reviewScore: next.reviewScore, mistakes: next.mistakes });
    return next;
  }

  return next;
}

export function buildQueueKey(dueAt, cardId) {
  return `${String(dueAt).padStart(13, "0")}_${cardId}`;
}
