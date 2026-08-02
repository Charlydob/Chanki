export const EASY_COUNT_TO_LEARN = 10;
export const GOOGLE_GERMAN_DECK_ID = "google-german-1000-words";
export const GOOGLE_GERMAN_DECK_NAME = "Alemán · 1000 palabras";
export const VOCABULARY_SCHEMA_VERSION = 1;
export const RATINGS = ["unknown", "bad", "good", "easy"];

const ARTICLES = new Set(["der", "die", "das"]);

export function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

export function normalizeArticleAndWord(article, word) {
  const clean = String(word || "").normalize("NFC").trim().replace(/\s+/g, " ");
  const parts = clean.split(" ");
  const typedArticle = ARTICLES.has((parts[0] || "").toLocaleLowerCase("de"))
    ? parts.shift().toLocaleLowerCase("de")
    : null;
  const selected = ARTICLES.has(String(article || "").toLowerCase()) ? String(article).toLowerCase() : null;
  while (parts.length && ARTICLES.has(parts[0].toLocaleLowerCase("de")) && parts[0].toLocaleLowerCase("de") === (selected || typedArticle)) parts.shift();
  return { article: selected || typedArticle, word: parts.join(" ").trim() };
}

export function normalizeVocabularyCard(input = {}, now = new Date().toISOString()) {
  const normalized = normalizeArticleAndWord(input.article, input.word ?? input.front);
  const count = (value) => Math.max(0, Math.trunc(Number(value) || 0));
  const easyCount = count(input.easyCount);
  return {
    id: String(input.id || createUuid()), position: Number.isInteger(Number(input.position)) ? Number(input.position) : null,
    article: normalized.article, word: normalized.word, meaning: String(input.meaning ?? input.back ?? "").trim(),
    exampleSentence: String(input.exampleSentence || "").trim(), exampleTranslation: String(input.exampleTranslation || "").trim(),
    learned: Boolean(input.learned) || easyCount >= EASY_COUNT_TO_LEARN,
    unknownCount: count(input.unknownCount), badCount: count(input.badCount), goodCount: count(input.goodCount), easyCount,
    ...(input.createdAt ? { createdAt: String(input.createdAt) } : {}), updatedAt: String(input.updatedAt || now),
    ...(input.remoteUpdatedAt ? { remoteUpdatedAt: String(input.remoteUpdatedAt) } : {}),
    source: ["local", "google_sheets", "merged"].includes(input.source) ? input.source : "local",
    syncStatus: ["synced", "pending_create", "pending_update", "conflict"].includes(input.syncStatus) ? input.syncStatus : "pending_create",
  };
}

export function duplicateKey(card) {
  const value = normalizeArticleAndWord(card.article, card.word);
  return `${value.article || ""}|${value.word.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de")}`;
}

export function applyRating(card, rating) {
  if (!RATINGS.includes(rating)) throw new Error("Valoración no válida");
  const next = normalizeVocabularyCard(card);
  next[`${rating}Count`] += 1;
  if (next.easyCount >= EASY_COUNT_TO_LEARN) next.learned = true;
  next.updatedAt = new Date().toISOString(); next.syncStatus = next.syncStatus === "pending_create" ? "pending_create" : "pending_update";
  return next;
}

export function mergeVocabularyCards(local, remote) {
  const left = normalizeVocabularyCard(local); const right = normalizeVocabularyCard(remote);
  const remoteWins = Date.parse(right.updatedAt) > Date.parse(left.updatedAt);
  const winner = remoteWins ? right : left;
  return normalizeVocabularyCard({ ...left, ...winner,
    unknownCount: Math.max(left.unknownCount, right.unknownCount), badCount: Math.max(left.badCount, right.badCount),
    goodCount: Math.max(left.goodCount, right.goodCount), easyCount: Math.max(left.easyCount, right.easyCount),
    learned: left.learned || right.learned, source: "merged", syncStatus: left.syncStatus === "conflict" ? "conflict" : "synced",
    remoteUpdatedAt: right.updatedAt,
  });
}
