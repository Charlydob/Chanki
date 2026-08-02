export const VOCABULARY_HEADER_ALIASES = Object.freeze({
  position: ["puesto"], article: ["der die das", "articulo", "artículo"], word: ["palabra"], meaning: ["significado"],
  exampleSentence: ["frase"], exampleTranslation: ["significado frase", "traduccion frase", "traducción frase"],
  learned: ["sabida", "sabida?"], unknownCount: ["veces no sabida"], badCount: ["veces mala"], goodCount: ["veces buena"],
  easyCount: ["veces facil", "veces fácil"], id: ["id"], updatedAt: ["actualizado"],
});
export function normalizeHeader(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " "); }
export function mapVocabularyHeaders(headers) { const normalized = headers.map(normalizeHeader); return Object.fromEntries(Object.entries(VOCABULARY_HEADER_ALIASES).map(([field, aliases]) => [field, normalized.findIndex((header) => aliases.map(normalizeHeader).includes(header))]).filter(([, index]) => index >= 0)); }
