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
    correctCount: 0,
    intervalMinutes: 0,
    intervalDays: 0,
    interval: 0,
    lapses: 0,
    mistakes: 0,
    ease: 2.3,
    reviewScore: 0,
    averageGrade: 0,
    srsLevel: "new",
    learningStep: 0,
    streak: 0,
    lastReviewedAt: 0,
    lastRatings: [],
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export function normalizeSrs(previous = {}, createdAt = Date.now()) {
  const now = Date.now();
  const raw = previous || {};
  const base = { ...defaultSrs(), ...raw };
  const nextReviewAt = firstFiniteNumber(raw.nextReviewAt, raw.dueAt, createdAt, now) || now;
  const reviewCount = firstFiniteNumber(raw.reviewCount, raw.repetitions, raw.reps) || 0;
  const mistakes = firstFiniteNumber(raw.mistakes, raw.lapses) || 0;
  const correctCount = firstFiniteNumber(raw.correctCount, Math.max(0, reviewCount - mistakes)) || 0;
  const intervalDays = firstFiniteNumber(raw.intervalDays, raw.interval) || 0;
  const intervalMinutes = firstFiniteNumber(raw.intervalMinutes, intervalDays * 24 * 60) || 0;
  const reviewScore = firstFiniteNumber(raw.reviewScore, Math.max(0, correctCount - mistakes)) || 0;
  const averageGrade = firstFiniteNumber(
    raw.averageGrade,
    reviewCount > 0 ? reviewScore / reviewCount : 0
  ) || 0;
  const lastReviewedAt = firstFiniteNumber(raw.lastReviewedAt) || 0;
  const bucket = classifySrsBucket({
    ...base,
    reviewCount,
    lastReviewedAt,
    nextReviewAt,
    dueAt: nextReviewAt,
  }, now);
  return {
    ...base,
    bucket,
    dueAt: nextReviewAt,
    nextReviewAt,
    reps: reviewCount,
    repetitions: reviewCount,
    reviewCount,
    correctCount,
    intervalMinutes,
    intervalDays,
    interval: intervalDays,
    mistakes,
    lapses: mistakes,
    ease: Math.max(1.3, Number(base.ease || 2.3)),
    reviewScore,
    averageGrade,
    srsLevel: raw.srsLevel || (reviewCount > 0 ? "review" : "new"),
    lastReviewedAt,
    lastRatings: Array.isArray(base.lastRatings) ? base.lastRatings.slice(-3) : [],
  };
}

export function hasReviewProgress(srs = {}) {
  return firstFiniteNumber(srs.reviewCount, srs.repetitions, srs.reps) > 0
    || firstFiniteNumber(srs.lastReviewedAt) > 0;
}

function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function classifySrsBucket(srs = {}, now = Date.now()) {
  if (!hasReviewProgress(srs)) return "new";
  const dueAt = firstFiniteNumber(srs.nextReviewAt, srs.dueAt, now) || now;
  if (dueAt <= now) return "immediate";
  if (dueAt < now + DAY) return "lt24h";
  const tomorrowStart = startOfLocalDay(now) + DAY;
  const dayAfterTomorrowStart = tomorrowStart + DAY;
  if (dueAt >= tomorrowStart && dueAt < dayAfterTomorrowStart) return "tomorrow";
  if (dueAt <= now + 7 * DAY) return "week";
  return "future";
}

export function classifyCardBucket(card = {}, now = Date.now()) {
  return classifySrsBucket(normalizeSrs(card.srs, card.createdAt), now);
}

function getIntervalDays(previous, now) {
  if (Number.isFinite(previous.intervalDays) && previous.intervalDays > 0) {
    return Math.max(1, Math.floor(previous.intervalDays));
  }
  if (Number.isFinite(previous.interval) && previous.interval > 0) {
    return Math.max(1, Math.floor(previous.interval));
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

function gradeRating(rating) {
  switch (rating) {
    case "error": return 0;
    case "bad": return 1;
    case "good": return 3;
    case "easy": return 4;
    default: return 3;
  }
}

function computeEffectiveEase(ease, lastRatings) {
  const scores = (lastRatings || []).map((rating) => scoreRating(rating));
  const recent = scores.length
    ? scores.reduce((sum, value) => sum + value, 0) / scores.length
    : 0.7;
  return ease * 0.6 + (1.3 + recent * 1.2) * 0.4;
}

function applySchedule(next, now, intervalMinutes, dueAt) {
  next.intervalMinutes = intervalMinutes;
  next.intervalDays = intervalMinutes >= 24 * 60 ? Math.max(1, Math.round(intervalMinutes / (24 * 60))) : 0;
  next.interval = next.intervalDays;
  next.dueAt = dueAt;
  next.nextReviewAt = dueAt;
  next.bucket = classifySrsBucket(next, now);
  console.info("[chanki:srs:next-review]", {
    cardId: next.cardId || null,
    rating: next.lastRatings?.[next.lastRatings.length - 1] || null,
    nextReviewAt: next.nextReviewAt,
    intervalMinutes: next.intervalMinutes,
    intervalDays: next.intervalDays,
    bucket: next.bucket,
    ease: next.ease,
    reviewCount: next.reviewCount,
    mistakes: next.mistakes,
    correctCount: next.correctCount,
    reviewScore: next.reviewScore,
    averageGrade: next.averageGrade,
    srsLevel: next.srsLevel,
  });
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
  const grade = gradeRating(rating);

  next.lastReviewedAt = now;
  next.reviewCount = currentRepetitions + 1;
  next.repetitions = next.reviewCount;
  next.reps = next.reviewCount;
  next.correctCount = (base.correctCount || 0) + (rating === "good" || rating === "easy" ? 1 : 0);
  next.averageGrade = (((base.averageGrade || 0) * currentRepetitions) + grade) / next.reviewCount;

  if (rating === "error") {
    next.reviewScore = Math.max(0, (base.reviewScore || 0) - 1);
    next.mistakes = (base.mistakes || 0) + 1;
    next.lapses = next.mistakes;
    next.ease = Math.max(1.3, (base.ease || 2.3) - 0.2);
    next.learningStep = 0;
    next.streak = 0;
    next.srsLevel = "learning";
    applySchedule(next, now, 20, now + 20 * MINUTE);
    return next;
  }

  if (rating === "bad") {
    next.reviewScore = Math.max(0, (base.reviewScore || 0) + 0.3);
    next.ease = Math.max(1.3, (base.ease || 2.3) - 0.15);
    next.streak = 0;
    next.srsLevel = "learning";
    applySchedule(next, now, 4 * 60, now + 4 * HOUR);
    return next;
  }

  if (rating === "good") {
    const intervalDays = currentRepetitions <= 0
      ? 1
      : Math.max(1, Math.floor(previousInterval * Math.max(1.4, effectiveEase)));
    next.reviewScore = (base.reviewScore || 0) + 1;
    next.ease = base.ease || 2.3;
    next.streak = (base.streak || 0) + 1;
    next.srsLevel = "review";
    applySchedule(next, now, intervalDays * 24 * 60, now + intervalDays * DAY);
    return next;
  }

  if (rating === "easy") {
    const intervalDays = currentRepetitions <= 0
      ? 3
      : Math.max(2, Math.floor(previousInterval * (effectiveEase + 0.8)));
    next.reviewScore = (base.reviewScore || 0) + 2;
    next.ease = (base.ease || 2.3) + 0.1;
    next.streak = (base.streak || 0) + 1;
    next.srsLevel = "review";
    applySchedule(next, now, intervalDays * 24 * 60, now + intervalDays * DAY);
    return next;
  }

  next.bucket = classifySrsBucket(next, now);
  return next;
}

export function buildQueueKey(dueAt, cardId) {
  return `${String(dueAt).padStart(13, "0")}_${cardId}`;
}
