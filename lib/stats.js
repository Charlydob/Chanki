import { increment, ref, update, get, child } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

export function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function keyToDate(key) {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4, 6)) - 1;
  const day = Number(key.slice(6, 8));
  return new Date(year, month, day);
}

function diffDays(currentKey, lastKey) {
  if (!currentKey || !lastKey) return null;
  const current = keyToDate(currentKey);
  const last = keyToDate(lastKey);
  const diff = current.setHours(0, 0, 0, 0) - last.setHours(0, 0, 0, 0);
  return Math.round(diff / 86400000);
}

export async function recordReviewStats(db, root, payload) {
  const todayKey = dayKey();
  const updates = {};
  const basePath = `${root}/stats`;

  const ratingField = payload.rating || "good";
  const minutes = payload.minutes || 0;
  const reviewIncrement = payload.isNew ? "new" : "reviews";

  updates[`${basePath}/daily/${todayKey}/${reviewIncrement}`] = increment(1);
  updates[`${basePath}/daily/${todayKey}/${ratingField}`] = increment(1);
  updates[`${basePath}/daily/${todayKey}/minutes`] = increment(minutes);
  updates[`${basePath}/buttonCountsDaily/${todayKey}/${ratingField}`] = increment(1);
  updates[`${basePath}/totals/totalReviews`] = increment(1);
  updates[`${basePath}/totals/totalMinutes`] = increment(minutes);

  if (payload.folderId) {
    updates[`${basePath}/byFolder/${payload.folderId}/${todayKey}/${reviewIncrement}`] = increment(1);
    updates[`${basePath}/byFolder/${payload.folderId}/${todayKey}/${ratingField}`] = increment(1);
  }

  if (payload.tags && payload.tags.length) {
    payload.tags.forEach((tag) => {
      const safeTag = tag.toLowerCase();
      updates[`${basePath}/byTag/${safeTag}/${todayKey}/${reviewIncrement}`] = increment(1);
      updates[`${basePath}/byTag/${safeTag}/${todayKey}/${ratingField}`] = increment(1);
    });
  }

  await update(ref(db), updates);

  const totalsSnap = await get(child(ref(db), `${basePath}/totals`));
  const totals = totalsSnap.exists() ? totalsSnap.val() : {};
  const lastReviewDay = totals.lastReviewDay;
  let currentStreak = totals.currentStreak || 0;
  let bestStreak = totals.bestStreak || 0;
  if (lastReviewDay === todayKey) {
    currentStreak = Math.max(1, currentStreak);
  } else if (diffDays(todayKey, lastReviewDay) === 1) {
    currentStreak += 1;
  } else {
    currentStreak = 1;
  }
  bestStreak = Math.max(bestStreak, currentStreak);
  await update(ref(db), {
    [`${basePath}/totals/currentStreak`]: currentStreak,
    [`${basePath}/totals/bestStreak`]: bestStreak,
    [`${basePath}/totals/lastReviewDay`]: todayKey,
  });
}

export async function fetchDailyStats(db, root, days = 7) {
  const now = Date.now();
  const keys = Array.from({ length: days }, (_, i) => dayKey(now - (days - 1 - i) * 86400000));
  const snap = await get(child(ref(db), `${root}/stats/daily`));
  const data = snap.exists() ? snap.val() : {};
  return keys.map((key) => ({
    key,
    ...data[key],
  }));
}

export async function fetchTotalsStats(db, root) {
  const snap = await get(child(ref(db), `${root}/stats/totals`));
  return snap.exists() ? snap.val() : {};
}

export async function fetchBucketCounts(db, root) {
  const snap = await get(child(ref(db), `${root}/stats/bucketCounts`));
  return snap.exists() ? snap.val() : {};
}

export function calcStreak(dailyStats) {
  let streak = 0;
  for (let i = dailyStats.length - 1; i >= 0; i -= 1) {
    const day = dailyStats[i];
    const total = (day.reviews || 0) + (day.new || 0);
    if (total > 0) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}
