import { Bucket, CardSrs, ReviewRating } from './types';

const DAY = 24 * 60 * 60 * 1000;

export const nextBucketAndDue = (srs: CardSrs, rating: ReviewRating, now: number) => {
  let bucket: Bucket = srs.bucket;
  let dueAt = now;
  let ease = srs.ease;
  let reps = srs.reps + 1;
  let lapses = srs.lapses;

  if (rating === 'error') {
    bucket = 'immediate';
    dueAt = now + 5 * 60 * 1000;
    lapses += 1;
    ease = Math.max(1.2, ease - 0.2);
  }

  if (rating === 'bad') {
    bucket = 'lt24h';
    dueAt = now + 6 * 60 * 60 * 1000;
    ease = Math.max(1.2, ease - 0.05);
  }

  if (rating === 'good') {
    bucket = 'tomorrow';
    dueAt = now + DAY;
    ease = Math.min(3.0, ease + 0.05);
  }

  if (rating === 'easy') {
    if (reps < 3) {
      bucket = 'week';
      dueAt = now + 7 * DAY;
    } else {
      bucket = 'future';
      const intervals = [14, 30, 60, 120];
      const idx = Math.min(intervals.length - 1, reps - 3);
      dueAt = now + intervals[idx] * DAY;
    }
    ease = Math.min(3.5, ease + 0.15);
  }

  return { bucket, dueAt, ease, reps, lapses };
};

export const initSrs = (now: number): CardSrs => ({
  bucket: 'new',
  dueAt: now,
  reps: 0,
  lapses: 0,
  ease: 2.0,
  lastReviewedAt: null,
});
