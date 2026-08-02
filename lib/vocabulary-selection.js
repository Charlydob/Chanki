export const VOCABULARY_WEIGHTS = Object.freeze({ learnedBase: 0.2, base: 1, unknown: 0.45, bad: 0.25, good: -0.05, easy: -0.08, minimum: 0.08 });
export const RECENT_CARD_LIMIT = 3;
export function getCardWeight(card) {
  const base = card.learned ? VOCABULARY_WEIGHTS.learnedBase : VOCABULARY_WEIGHTS.base;
  return Math.max(VOCABULARY_WEIGHTS.minimum, base + card.unknownCount * VOCABULARY_WEIGHTS.unknown + card.badCount * VOCABULARY_WEIGHTS.bad + card.goodCount * VOCABULARY_WEIGHTS.good + card.easyCount * VOCABULARY_WEIGHTS.easy);
}
export function selectWeightedCard(cards, recentIds = [], random = Math.random) {
  if (!cards.length) return null;
  const excluded = new Set(recentIds.slice(-RECENT_CARD_LIMIT));
  const eligible = cards.length >= 4 ? cards.filter((card) => !excluded.has(card.id)) : cards.filter((card) => card.id !== recentIds.at(-1));
  const pool = eligible.length ? eligible : cards; const total = pool.reduce((sum, card) => sum + getCardWeight(card), 0);
  let cursor = random() * total;
  for (const card of pool) { cursor -= getCardWeight(card); if (cursor <= 0) return card; }
  return pool.at(-1);
}
