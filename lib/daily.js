import { get, ref, update } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { userRoot } from "./rtdb.js";

const LEVEL_WEIGHT = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };
const FALLBACK_KEY = "chanki_daily_v1";

export function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function loadDailySeed() {
  const [nouns, verbs, sentences] = await Promise.all([
    fetch("./data/nouns.json").then((r) => r.json()),
    fetch("./data/verbs.json").then((r) => r.json()),
    fetch("./data/sentences.json").then((r) => r.json()),
  ]);
  return { nouns, verbs, sentences };
}

function getFallbackStore() {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_KEY) || "{}");
  } catch (_) {
    return {};
  }
}

function setFallbackStore(value) {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(value));
}

function scoreItem(item, progress = {}) {
  const seen = Number(progress.seenCount || 0);
  const lastShownAt = Number(progress.lastShownAt || 0);
  const agePenalty = lastShownAt ? Math.max(0, (Date.now() - lastShownAt) / 3600000) : 999;
  const levelScore = LEVEL_WEIGHT[item.level] ?? 9;
  return seen * 100 + levelScore * 10 - Math.min(agePenalty, 72);
}

function pickItems(type, catalog, count, progressMap, excludeIds = []) {
  const excluded = new Set(excludeIds);
  return catalog
    .filter((item) => {
      const progress = progressMap[item.id] || {};
      return !progress.known && !excluded.has(item.id);
    })
    .sort((a, b) => scoreItem(a, progressMap[a.id] || {}) - scoreItem(b, progressMap[b.id] || {}))
    .slice(0, count)
    .map((item) => ({ ...item, type }));
}

export function selectDailyNouns(catalog, progressMap, excludeIds = []) {
  return pickItems("noun", catalog, 2, progressMap, excludeIds);
}

export function selectDailyVerb(catalog, progressMap, excludeIds = []) {
  return pickItems("verb", catalog, 1, progressMap, excludeIds)[0] || null;
}

export function selectDailySentence(catalog, progressMap, relatedIds = []) {
  const relatedSet = new Set(relatedIds);
  const ranked = pickItems("sentence", catalog, 40, progressMap);
  const related = ranked.find((item) => {
    const linkedWords = item.linkedWordIds || [];
    const linkedVerbs = item.linkedVerbIds || [];
    return [...linkedWords, ...linkedVerbs].some((id) => relatedSet.has(id));
  });
  return related || ranked[0] || null;
}

function buildDailyRoot(uid) {
  return `${userRoot(uid)}/chankiDaily`;
}

async function readDailyFirebase(db, uid) {
  const snap = await get(ref(db, buildDailyRoot(uid)));
  return snap.exists() ? snap.val() : {};
}

async function patchDailyFirebase(db, updates) {
  await update(ref(db), updates);
}

export async function getDailyBundle(db, uid, dateKey, seed) {
  const local = getFallbackStore();
  let remote = {};
  let firebaseOk = true;
  try {
    remote = await readDailyFirebase(db, uid);
  } catch (_) {
    firebaseOk = false;
  }
  const cache = remote?.daily?.[dateKey] || local?.daily?.[dateKey] || null;
  const progressItems = remote?.progress?.items || local?.progress?.items || {};

  let bundle = cache?.bundle || null;
  if (!bundle) {
    const nouns = selectDailyNouns(seed.nouns, progressItems);
    const verb = selectDailyVerb(seed.verbs, progressItems);
    const sentence = selectDailySentence(seed.sentences, progressItems, [
      nouns[0]?.id,
      nouns[1]?.id,
      verb?.id,
    ]);
    bundle = {
      nounIds: nouns.map((n) => n.id),
      verbId: verb?.id || null,
      sentenceId: sentence?.id || null,
      createdAt: Date.now(),
      replacements: [],
    };
  }

  const verbAnswers = cache?.verbAnswers || {};
  if (firebaseOk) {
    const root = buildDailyRoot(uid);
    await patchDailyFirebase(db, {
      [`${root}/daily/${dateKey}/bundle`]: bundle,
      [`${root}/daily/${dateKey}/updatedAt`]: Date.now(),
      [`${root}/catalog/meta/seedVersion`]: 1,
    });
  }

  const nextLocal = {
    ...local,
    daily: {
      ...(local.daily || {}),
      [dateKey]: {
        bundle,
        verbAnswers,
      },
    },
    progress: {
      items: progressItems,
    },
  };
  setFallbackStore(nextLocal);

  return { bundle, progressItems, verbAnswers, firebaseOk };
}

export async function markItemKnown(db, uid, item) {
  return updateItemProgress(db, uid, item, { known: true });
}

export async function updateItemProgress(db, uid, item, patch = {}) {
  const local = getFallbackStore();
  const existing = local?.progress?.items?.[item.id] || {};
  const next = {
    id: item.id,
    type: item.type,
    german: item.german,
    spanish: item.spanish,
    level: item.level || "",
    tags: item.tags || [],
    known: !!(patch.known ?? existing.known),
    seenCount: Number(existing.seenCount || 0) + 1,
    lastShownAt: Date.now(),
    createdAt: Number(existing.createdAt || Date.now()),
    updatedAt: Date.now(),
  };
  const store = {
    ...local,
    progress: {
      items: {
        ...(local.progress?.items || {}),
        [item.id]: next,
      },
    },
  };
  setFallbackStore(store);
  try {
    const root = buildDailyRoot(uid);
    await patchDailyFirebase(db, {
      [`${root}/progress/items/${item.id}`]: next,
    });
  } catch (_) {
    // localStorage fallback only
  }
  return next;
}

export async function replaceDailyItem(db, uid, dateKey, type, currentId, seed, progressItems, currentBundle) {
  const source = type === "noun" ? seed.nouns : type === "verb" ? seed.verbs : seed.sentences;
  const picked = pickItems(type, source, 1, progressItems, [currentId])[0] || null;
  if (!picked) return null;

  const bundle = {
    ...currentBundle,
    replacements: [
      ...(currentBundle.replacements || []),
      { type, from: currentId, to: picked.id, at: Date.now() },
    ],
  };

  if (type === "noun") {
    bundle.nounIds = (bundle.nounIds || []).map((id) => (id === currentId ? picked.id : id));
  } else if (type === "verb") {
    bundle.verbId = picked.id;
  } else {
    bundle.sentenceId = picked.id;
  }

  const local = getFallbackStore();
  setFallbackStore({
    ...local,
    daily: {
      ...(local.daily || {}),
      [dateKey]: {
        ...(local.daily?.[dateKey] || {}),
        bundle,
      },
    },
  });

  try {
    const root = buildDailyRoot(uid);
    await patchDailyFirebase(db, {
      [`${root}/daily/${dateKey}/bundle`]: bundle,
      [`${root}/daily/${dateKey}/updatedAt`]: Date.now(),
    });
  } catch (_) {
    // fallback
  }

  return { ...picked, type };
}

export async function saveVerbExerciseAnswers(db, uid, dateKey, verbId, data) {
  const local = getFallbackStore();
  const nextDaily = {
    ...(local.daily?.[dateKey] || {}),
    verbAnswers: {
      ...(local.daily?.[dateKey]?.verbAnswers || {}),
      [verbId]: data,
    },
  };
  setFallbackStore({
    ...local,
    daily: {
      ...(local.daily || {}),
      [dateKey]: nextDaily,
    },
  });
  try {
    const root = buildDailyRoot(uid);
    await patchDailyFirebase(db, {
      [`${root}/daily/${dateKey}/verbAnswers/${verbId}`]: data,
      [`${root}/daily/${dateKey}/updatedAt`]: Date.now(),
    });
  } catch (_) {
    // fallback
  }
}
