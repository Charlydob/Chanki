import assert from "node:assert/strict";
import { computeNextSrs, defaultSrs, normalizeSrs } from "../lib/srs.js";

const before = Date.now();
const base = { ...defaultSrs(), dueAt: before - 1000, nextReviewAt: before - 1000, reviewCount: 2, repetitions: 2, reps: 2, interval: 1, intervalDays: 1, reviewScore: 2, mistakes: 0 };

const error = computeNextSrs(base, "error");
assert.equal(error.reviewCount, 3);
assert.equal(error.mistakes, 1);
assert.ok(error.nextReviewAt > before + 9 * 60 * 1000, "error should not be due immediately");
assert.equal(error.bucket, "immediate");

const good = computeNextSrs(base, "good");
assert.ok(good.interval >= 1);
assert.ok(good.nextReviewAt >= before + 23 * 60 * 60 * 1000);

const easy = computeNextSrs(base, "easy");
assert.ok(easy.interval > good.interval, "easy should space farther than normal");
assert.ok(easy.reviewScore > good.reviewScore);

const legacy = normalizeSrs({ reps: 4, dueAt: 123, lapses: 2 }, 100);
assert.equal(legacy.nextReviewAt, 123);
assert.equal(legacy.reviewCount, 4);
assert.equal(legacy.mistakes, 2);
assert.equal(legacy.reviewScore, 2);

console.log("srs tests passed");
