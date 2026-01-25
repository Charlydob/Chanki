const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function defaultSrs() {
  return {
    bucket: "new",
    dueAt: Date.now(),
    reps: 0,
    lapses: 0,
    ease: 2.5,
    lastReviewedAt: 0,
  };
}

function futureInterval(reps) {
  const steps = [14, 30, 60, 120, 240];
  const index = Math.min(steps.length - 1, Math.max(0, reps - 3));
  return steps[index] * DAY;
}

export function computeNextSrs(previous, rating) {
  const now = Date.now();
  const next = { ...previous };
  next.reps = (previous.reps || 0) + 1;
  next.lastReviewedAt = now;

  if (rating === "error") {
    next.bucket = "immediate";
    next.dueAt = now + 5 * MINUTE;
    next.lapses = (previous.lapses || 0) + 1;
    next.ease = Math.max(1.3, (previous.ease || 2.5) - 0.2);
    return next;
  }

  if (rating === "bad") {
    next.bucket = "lt24h";
    next.dueAt = now + 6 * HOUR;
    next.ease = Math.max(1.4, (previous.ease || 2.5) - 0.05);
    return next;
  }

  if (rating === "good") {
    next.bucket = "tomorrow";
    next.dueAt = now + DAY;
    next.ease = (previous.ease || 2.5) + 0.05;
    return next;
  }

  if (rating === "easy") {
    next.ease = (previous.ease || 2.5) + 0.15;
    if (next.reps < 3) {
      next.bucket = "week";
      next.dueAt = now + 7 * DAY;
    } else {
      next.bucket = "future";
      next.dueAt = now + futureInterval(next.reps);
    }
    return next;
  }

  return next;
}

export function buildQueueKey(dueAt, cardId) {
  return `${String(dueAt).padStart(13, "0")}_${cardId}`;
}
