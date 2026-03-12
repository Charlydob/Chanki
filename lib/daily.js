import { get, ref, update } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { userRoot } from "./rtdb.js";

const FALLBACK_KEY = "chanki_daily_v2";
const DICT_BASE = "https://api.dictionaryapi.dev/api/v2/entries/de";
const TATOEBA_BASE = "https://tatoeba.org/en/api_v0/search";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const RECENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;

const LOCAL_EMERGENCY = {
  nouns: [
    { id: "fallback_noun_Haus", source: "local-fallback", sourceId: "Haus", type: "noun", german: "Haus", spanish: "casa", article: "das", plural: "Häuser" },
    { id: "fallback_noun_Buch", source: "local-fallback", sourceId: "Buch", type: "noun", german: "Buch", spanish: "libro", article: "das", plural: "Bücher" },
    { id: "fallback_noun_Zeit", source: "local-fallback", sourceId: "Zeit", type: "noun", german: "Zeit", spanish: "tiempo", article: "die", plural: "Zeiten" },
  ],
  verbs: [
    { id: "fallback_verb_machen", source: "local-fallback", sourceId: "machen", type: "verb", german: "machen", spanish: "hacer" },
    { id: "fallback_verb_gehen", source: "local-fallback", sourceId: "gehen", type: "verb", german: "gehen", spanish: "ir" },
  ],
  sentences: [
    { id: "fallback_sentence_1", source: "local-fallback", sourceId: "1", type: "sentence", german: "Heute lerne ich Deutsch.", spanish: "Hoy aprendo alemán." },
    { id: "fallback_sentence_2", source: "local-fallback", sourceId: "2", type: "sentence", german: "Wir trinken heute Kaffee.", spanish: "Hoy bebemos café." },
  ],
};

const COMMON_GERMAN_LEMMAS = ["Haus", "Buch", "Freund", "Arbeit", "Zeit", "Wasser", "lernen", "machen", "gehen", "kommen", "sehen", "sprechen"];

export function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
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

function normalizeWord(word) {
  return String(word || "")
    .trim()
    .replace(/[^\p{L}-]/gu, "")
    .slice(0, 60);
}

async function fetchJsonWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildCacheRecord(item) {
  return { ...item, cachedAt: Date.now() };
}

function cacheAlive(item) {
  return item && Date.now() - Number(item.cachedAt || 0) < CACHE_TTL_MS;
}

function extractSpanishFromDictionary(entry) {
  const definitions = entry?.meanings?.flatMap((meaning) => meaning.definitions || []) || [];
  const candidates = definitions.map((d) => d.definition).filter(Boolean);
  return candidates[0] || "";
}

function inferArticle(word) {
  if (/^(der|die|das)\s+/i.test(word)) return word.split(/\s+/)[0].toLowerCase();
  if (/ung$/i.test(word) || /heit$/i.test(word) || /keit$/i.test(word)) return "die";
  if (/chen$/i.test(word) || /lein$/i.test(word)) return "das";
  return "";
}

function buildWordItem(entry, lemma) {
  const normalizedLemma = normalizeWord(lemma) || normalizeWord(entry?.word);
  const meanings = entry?.meanings || [];
  const part = meanings[0]?.partOfSpeech || "";
  const isVerb = meanings.some((m) => /verb/i.test(m.partOfSpeech || ""));
  const isNoun = meanings.some((m) => /noun/i.test(m.partOfSpeech || ""));
  if (!normalizedLemma || (!isVerb && !isNoun)) return null;
  const sourceId = normalizedLemma.toLowerCase();
  const type = isVerb ? "verb" : "noun";
  const nounForms = entry?.meanings?.find((m) => /noun/i.test(m.partOfSpeech || ""))?.definitions || [];
  const firstNounDef = nounForms[0] || {};
  const spanish = extractSpanishFromDictionary(entry) || firstNounDef.definition || `Meaning (${part || "de"})`;
  return {
    id: `dict_${type}_${sourceId}`,
    source: "dictionaryapi",
    sourceId,
    type,
    german: normalizedLemma,
    spanish,
    article: type === "noun" ? inferArticle(normalizedLemma) : "",
    plural: type === "noun" ? (firstNounDef.example || "") : "",
    tags: ["api", "dictionaryapi"],
  };
}

async function dictionaryLookup(word, dictionaryCache = {}) {
  const key = normalizeWord(word).toLowerCase();
  if (!key) return null;
  if (cacheAlive(dictionaryCache[key])) return dictionaryCache[key].item;
  try {
    const payload = await fetchJsonWithTimeout(`${DICT_BASE}/${encodeURIComponent(key)}`);
    const first = Array.isArray(payload) ? payload[0] : null;
    const item = buildWordItem(first, key);
    dictionaryCache[key] = buildCacheRecord({ item, ok: true });
    return item;
  } catch (_) {
    dictionaryCache[key] = buildCacheRecord({ item: null, ok: false });
    return null;
  }
}

function extractSentenceRecord(raw, targetLang = "spa") {
  const german = raw?.text || raw?.sentence || "";
  const translations = Array.isArray(raw?.translations) ? raw.translations.flat() : [];
  const translation = translations.find((item) => item?.lang === targetLang)?.text
    || translations.find((item) => item?.lang === "eng")?.text
    || raw?.trans_text
    || "";
  if (!german) return null;
  const sourceId = String(raw?.id || raw?.sentence_id || german).slice(0, 80);
  return {
    id: `tatoeba_sentence_${sourceId}`,
    source: "tatoeba",
    sourceId,
    type: "sentence",
    german,
    spanish: translation || "(sin traducción disponible)",
    tags: ["api", "tatoeba"],
  };
}

export async function fetchSentenceCandidates(cache = {}) {
  const cacheKey = "de_spa";
  if (cacheAlive(cache[cacheKey])) return cache[cacheKey].items || [];
  const randomPage = Math.max(1, Math.floor(Math.random() * 8) + 1);
  const params = new URLSearchParams({ from: "deu", to: "spa", sort: "random", page: String(randomPage), per_page: "20" });
  try {
    const payload = await fetchJsonWithTimeout(`${TATOEBA_BASE}?${params.toString()}`);
    const rows = payload?.results || payload?.data || [];
    const items = rows.map((row) => extractSentenceRecord(row, "spa")).filter(Boolean);
    cache[cacheKey] = buildCacheRecord({ items, ok: true });
    return items;
  } catch (_) {
    cache[cacheKey] = buildCacheRecord({ items: [], ok: false });
    return [];
  }
}

function tokenizeGerman(text) {
  return String(text || "")
    .split(/\s+/)
    .map((part) => normalizeWord(part))
    .filter((token) => token.length >= 3);
}

export async function fetchWordCandidates(dictionaryCache = {}, sentenceItems = []) {
  const seedWords = new Set(COMMON_GERMAN_LEMMAS);
  sentenceItems.forEach((sentence) => tokenizeGerman(sentence.german).forEach((token) => seedWords.add(token)));
  const words = Array.from(seedWords).slice(0, 20);
  const resolved = [];
  for (const word of words) {
    // eslint-disable-next-line no-await-in-loop
    const item = await dictionaryLookup(word, dictionaryCache);
    if (item) resolved.push(item);
  }
  return resolved;
}

export async function fetchVerbCandidates(dictionaryCache = {}, sentenceItems = []) {
  const candidates = await fetchWordCandidates(dictionaryCache, sentenceItems);
  return candidates.filter((item) => item.type === "verb");
}

function scoreItem(item, progress = {}) {
  const seen = Number(progress.seenCount || 0);
  const lastShownAt = Number(progress.lastShownAt || 0);
  const isRecent = lastShownAt && Date.now() - lastShownAt < RECENT_WINDOW_MS ? 1 : 0;
  return seen * 100 + isRecent * 1000;
}

function pickItems(type, catalog, count, progressMap, excludeIds = []) {
  const excluded = new Set(excludeIds);
  return catalog
    .filter((item) => {
      const progress = progressMap[item.id] || {};
      return item.type === type && !progress.known && !excluded.has(item.id);
    })
    .sort((a, b) => scoreItem(a, progressMap[a.id] || {}) - scoreItem(b, progressMap[b.id] || {}))
    .slice(0, count);
}

function mergeUniqueById(items = []) {
  const map = new Map();
  items.forEach((item) => {
    if (item?.id) map.set(item.id, item);
  });
  return Array.from(map.values());
}

function resolveCatalogItems(remote, local) {
  return {
    nouns: mergeUniqueById([...(remote?.nouns || []), ...(local?.nouns || [])]),
    verbs: mergeUniqueById([...(remote?.verbs || []), ...(local?.verbs || [])]),
    sentences: mergeUniqueById([...(remote?.sentences || []), ...(local?.sentences || [])]),
  };
}

function ensureBundle(bundle, catalog, progressItems) {
  if (bundle?.nounIds?.length === 2 && bundle.verbId && bundle.sentenceId) return bundle;
  const nouns = pickItems("noun", catalog.nouns, 2, progressItems);
  const verb = pickItems("verb", catalog.verbs, 1, progressItems)[0] || null;
  const sentence = pickItems("sentence", catalog.sentences, 1, progressItems)[0] || null;
  return {
    nounIds: nouns.map((item) => item.id),
    verbId: verb?.id || null,
    sentenceId: sentence?.id || null,
    createdAt: Date.now(),
    replacements: [],
    knownActions: [],
    cardsCreated: [],
  };
}

export async function getDailyBundle(db, uid, dateKey) {
  const local = getFallbackStore();
  let remote = {};
  let firebaseOk = true;
  try {
    remote = await readDailyFirebase(db, uid);
  } catch (_) {
    firebaseOk = false;
  }

  const remoteCache = remote?.cache || {};
  const localCache = local?.cache || {};
  const dictionaryWordsCache = { ...(remoteCache.dictionaryWords || {}), ...(localCache.dictionaryWords || {}) };
  const tatoebaCache = { ...(remoteCache.tatoebaSentences || {}), ...(localCache.tatoebaSentences || {}) };

  const sentenceCandidates = await fetchSentenceCandidates(tatoebaCache);
  const wordCandidates = await fetchWordCandidates(dictionaryWordsCache, sentenceCandidates);
  const verbCandidates = wordCandidates.filter((item) => item.type === "verb");
  const nounCandidates = wordCandidates.filter((item) => item.type === "noun");

  const catalog = resolveCatalogItems(
    {
      nouns: nounCandidates,
      verbs: verbCandidates,
      sentences: sentenceCandidates,
    },
    {
      nouns: LOCAL_EMERGENCY.nouns,
      verbs: LOCAL_EMERGENCY.verbs,
      sentences: LOCAL_EMERGENCY.sentences,
    }
  );

  const cache = remote?.daily?.[dateKey] || local?.daily?.[dateKey] || {};
  const progressItems = remote?.progress?.items || local?.progress?.items || {};
  const bundle = ensureBundle(cache?.bundle, catalog, progressItems);
  const verbAnswers = cache?.verbAnswers || {};

  const nextLocal = {
    ...local,
    cache: {
      dictionaryWords: dictionaryWordsCache,
      dictionaryVerbs: dictionaryWordsCache,
      tatoebaSentences: tatoebaCache,
    },
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

  if (firebaseOk) {
    const root = buildDailyRoot(uid);
    await patchDailyFirebase(db, {
      [`${root}/cache/dictionaryWords`]: dictionaryWordsCache,
      [`${root}/cache/dictionaryVerbs`]: dictionaryWordsCache,
      [`${root}/cache/tatoebaSentences`]: tatoebaCache,
      [`${root}/daily/${dateKey}/bundle`]: bundle,
      [`${root}/daily/${dateKey}/updatedAt`]: Date.now(),
    });
  }

  return { bundle, progressItems, verbAnswers, catalog, firebaseOk };
}

export async function markItemKnown(db, uid, item) {
  return updateItemProgress(db, uid, item, { known: true });
}

export async function updateItemProgress(db, uid, item, patch = {}) {
  const local = getFallbackStore();
  const existing = local?.progress?.items?.[item.id] || {};
  const next = {
    id: item.id,
    source: item.source || existing.source || "",
    sourceId: item.sourceId || existing.sourceId || "",
    type: item.type,
    german: item.german,
    spanish: item.spanish,
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

export async function replaceDailyItem(db, uid, dateKey, type, currentId, catalog, progressItems, currentBundle) {
  const list = type === "noun" ? catalog.nouns : type === "verb" ? catalog.verbs : catalog.sentences;
  const picked = pickItems(type, list, 1, progressItems, [currentId])[0] || null;
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

export async function registerCardCreated(db, uid, dateKey, cardInfo) {
  const local = getFallbackStore();
  const cardsCreated = [...(local.daily?.[dateKey]?.cardsCreated || []), cardInfo];
  setFallbackStore({
    ...local,
    daily: {
      ...(local.daily || {}),
      [dateKey]: {
        ...(local.daily?.[dateKey] || {}),
        cardsCreated,
      },
    },
  });
  try {
    const root = buildDailyRoot(uid);
    await patchDailyFirebase(db, {
      [`${root}/daily/${dateKey}/cardsCreated`]: cardsCreated,
      [`${root}/daily/${dateKey}/updatedAt`]: Date.now(),
    });
  } catch (_) {
    // fallback
  }
}
