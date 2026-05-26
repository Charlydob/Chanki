import { getDb } from "../lib/firebase.js";
import {
  listenFolders,
  listenFolderById,
  listenCardsByUser,
  listenSharedFoldersByUser,
  listenFolderShares,
  upsertCardWithDedupe,
  deleteCard,
  moveCardFolder,
  fetchCardsByFolder,
  fetchCardsByFolderId,
  fetchCardsByFolderQueue,
  fetchCardsForSearch,
  fetchSampleCards,
  updateReview,
  fetchUserData,
  userRoot,
  fetchGlossaryWord,
  upsertGlossaryEntries,
  listenLexicon,
  upsertLexiconEntry,
  fetchUsersPublic,
  upsertUserPublic,
  shareFolder,
  unshareFolder,
  migrateDedupeV2Once,
  ensureVocabFolders,
  createOrUpdateVocabCard,
  listenTagsIndex,
  normalizeFolderPath,
} from "../lib/rtdb.js";
import {
  createFolder,
  deleteFolder,
  ensureFolderIdForImportPath,
  importCards,
  loadFolders,
  migrateLegacyCardFoldersOnce,
  updateCard,
  updateFolder,
} from "../lib/data-layer.js";
import { parseChankiImport } from "../lib/parser.js";
import { parseGermanConjugationPaste } from "../lib/verb-conjugation-parser.js";
import { computeNextSrs } from "../lib/srs.js";
import { recordReviewStats } from "../lib/stats.js";
import {
  buildOrderSolution,
  buildOrderState,
  evaluateOrderState,
  insertFromAvailable,
  moveOrderToken,
  moveSelected,
  resetOrderState,
  shouldShowOrderSolution,
} from "./order-utils.js";
import {
  BUCKET_LABELS,
  BUCKET_ORDER,
  canonicalizeBucketId,
  dedupeTags,
  elements,
  getReviewFolderSelections,
  getReviewTagFilters,
  normalizeSearchQuery,
  normalizeTags,
  normalizeText,
  state,
} from "./shared.js";
import { refreshReviewBucketCounts } from "./screens/review.js";
import { loadStats } from "./screens/stats.js";
import { initDailyScreen } from "./screens/daily.js";
import { getVisibleReviewFolderOptionIds, renderFolders, renderFolderSelects } from "./screens/folders.js";
import { getReviewCandidates, loadReviewCards } from "./review-candidates.js";
import { translateTextWithFallback } from "./translationService.js";

const APP_VERSION = "0.15.0";
const APP_BASE = (() => {
  const fromMeta = document.querySelector('meta[name="app-base"]')?.content;
  const basePath = new URL(fromMeta || "./", window.location.href).pathname;
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
})();

const REVIEW_PREFS_KEY = "chanki_review_selector_prefs";
const REVIEW_FOLDER_IDS_KEY = "reviewFolderIds";
let reviewFolderSearchDebounce = null;

function buildAppPath(path = "") {
  const safePath = String(path).replace(/^\/+/, "");
  return `/${safePath}`;
}

function getRouteWithinApp() {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  if (!hash) return "/";
  const clean = hash.startsWith("/") ? hash : `/${hash}`;
  const [pathOnly] = clean.split("?");
  return pathOnly || "/";
}

function updateBrowserRoute(path, mode = "push") {
  const nextPath = buildAppPath(path);
  const currentHashPath = String(window.location.hash || "").replace(/^#/, "") || "/";
  if (currentHashPath === nextPath) return;
  if (mode === "replace") {
    window.history.replaceState({}, "", `#${nextPath}`);
    return;
  }
  window.history.pushState({}, "", `#${nextPath}`);
}

function updateStandaloneHint() {
  if (!elements.app) return;
  const hint = document.getElementById("standalone-hint");
  if (!hint) return;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  hint.classList.toggle("hidden", isStandalone);
}

function persistReviewSelectorPrefs() {
  const payload = {
    selectedFolderIds: state.reviewSelectedFolderIds || [],
    includeTags: Array.from(state.reviewSelectedTags || []),
    excludeTags: Array.from(state.reviewExcludeTags || []),
    searchQuery: state.reviewFolderSearchQuery || "",
    includeMode: state.reviewTagFilterMode || "or",
    timestamp: Date.now(),
  };
  localStorage.setItem(REVIEW_PREFS_KEY, JSON.stringify(payload));
  localStorage.setItem(REVIEW_FOLDER_IDS_KEY, JSON.stringify(state.reviewSelectedFolderIds || []));
}

function restoreReviewSelectorPrefs() {
  try {
    const raw = localStorage.getItem(REVIEW_PREFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const byPrefs = Array.isArray(parsed.selectedFolderIds) ? parsed.selectedFolderIds : [];
    let byKey = [];
    try { byKey = JSON.parse(localStorage.getItem(REVIEW_FOLDER_IDS_KEY) || "[]"); } catch (_) { byKey = []; }
    state.reviewSelectedFolderIds = byKey.length ? byKey : byPrefs;
    state.reviewSelectedTags = new Set(Array.isArray(parsed.includeTags) ? parsed.includeTags : []);
    state.reviewExcludeTags = new Set(Array.isArray(parsed.excludeTags) ? parsed.excludeTags : []);
    state.reviewFolderSearchQuery = parsed.searchQuery || "";
    state.reviewTagFilterMode = parsed.includeMode === "and" ? "and" : "or";
  } catch (error) {
    console.warn("Cannot restore review selector prefs", error);
  }
}

function sanitizeReviewFolderSelections() {
  const validOwned = new Set(Object.keys(state.folders || {}));
  const validShared = new Set(Object.keys(state.sharedFolders || {}).map((key) => `shared:${key}`));
  state.reviewSelectedFolderIds = (state.reviewSelectedFolderIds || []).filter((value) => {
    if (value.startsWith("shared:")) return validShared.has(value);
    return validOwned.has(value);
  });
}

function resetReviewSelectorPrefs() {
  state.reviewSelectedFolderIds = [];
  state.reviewSelectedTags = new Set();
  state.reviewExcludeTags = new Set();
  state.reviewFolderSearchQuery = "";
  if (elements.reviewTags) elements.reviewTags.value = "";
  if (elements.reviewTagsExclude) elements.reviewTagsExclude.value = "";
  if (elements.reviewFolderSearch) elements.reviewFolderSearch.value = "";
  localStorage.removeItem(REVIEW_PREFS_KEY);
  localStorage.removeItem(REVIEW_FOLDER_IDS_KEY);
  renderFolderSelects();
  renderTagPanels();
  refreshReviewBucketCounts();
}


window.onerror = (message, source, lineno, colno, error) => {
  console.error("JS ERROR", error || message, source, lineno, colno);
  showToast(`Error JS: ${message}`, "error");
};

console.log("APP BOOT OK", APP_VERSION);
console.log(
  "BIND search:",
  !!elements.cardsSearchInput,
  "loadMore:",
  !!elements.loadMore,
  "edit:",
  !!elements.reviewEditCard
);

let editingCardId = null;
let activeUnsubscribe = null;
let editingFolderId = null;
let wordPopover = null;
let wordPopoverTitle = null;
let wordPopoverMeaning = null;
let wordPopoverEditor = null;
let wordPopoverInput = null;
let wordPopoverSave = null;
let wordPopoverFolderSelect = null;
let wordPopoverGenderButtons = null;
let wordPopoverAnchor = null;
let wordPopoverEditing = false;
let reviewEditModal = null;
let reviewEditCardId = null;
let reviewEditType = "basic";
let reviewEditFront = null;
let reviewEditBack = null;
let reviewEditClozeText = null;
let reviewEditClozeAnswers = null;
let reviewEditOrderTokens = null;
let reviewEditOrderLabels = null;
let reviewEditOrderAnswer = null;
let reviewEditOrderHelp = null;
let reviewEditCancel = null;
let reviewEditClose = null;
let reviewEditSave = null;
let reviewEditOwnerUid = null;
let reviewEditRole = null;
let reviewEditIsShared = false;
let tagsIndexUnsubscribe = null;
let lexiconUnsubscribe = null;
let sharedFoldersUnsubscribe = null;
let sharedFolderListeners = new Map();
let folderSharesUnsubscribe = null;
let cardsCountUnsubscribe = null;
let menuPortal = null;
let menuPortalAnchor = null;
let menuPortalCleanup = null;
let shareContext = null;
let shareSearchTimer = null;
const importState = {
  mode: "generic",
  forcedFolderId: null,
  forcedFolderLabel: null,
  sourceScreen: "import",
};
const swipeState = {
  active: false,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  pointerId: null,
  action: null,
};

let cardBackManuallyEdited = false;
let cardFrontManuallyEdited = false;
let currentGrammarType = "normal";
let cardNounGender = null;
const VERB_TEMPLATE = "[verbo]\nich -\ndu -\ner / sie / es -\nwir -\nihr -\nsie / Sie -";
let cardLastTranslation = "";
let cardTranslateAbortController = null;
const translationCache = new Map();
let reviewConjugationHeading = "";

const LANGUAGE_LABELS = { es: "Español", de: "Alemán", ru: "Ruso", en: "Inglés" };
const LANGUAGE_INPUT_CLASSES = ["lang-bg-es", "lang-bg-de", "lang-bg-ru"];

function getActiveFolderLanguages() {
  const folder = state.folders?.[state.selectedFolderId] || {};
  return {
    sourceLang: folder?.sourceLang || "es",
    targetLang: folder?.targetLang || "de",
  };
}
const SPEECH_LANGUAGE_MAP = { es: ["es-ES", "es"], de: ["de-DE", "de"], en: ["en-US", "en"] };
function normalizeSpeechLang(lang = "") {
  const normalized = String(lang || "").trim().toLowerCase();
  if (!normalized) return "en";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("de")) return "de";
  if (normalized.startsWith("en")) return "en";
  return normalized;
}
function getVoiceForLanguage(lang = "") {
  const normalized = normalizeSpeechLang(lang);
  const preferences = SPEECH_LANGUAGE_MAP[normalized] || [normalized];
  const locale = preferences[0];
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const exact = voices.find((voice) => String(voice.lang || "").toLowerCase() === locale.toLowerCase());
  if (exact) return { locale, voice: exact };
  const byPrefix = voices.find((voice) => preferences.some(
    (pref) => String(voice.lang || "").toLowerCase().startsWith(pref.toLowerCase())
  ));
  return { locale, voice: byPrefix || null };
}
function normalizeEsText(text = "") {
  return String(text || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function looksLikeSpanishNounPhrase(text = "") {
  const raw = String(text || "").trim();
  const lower = normalizeEsText(raw);
  if (!/^(la|el|los|las)\s+/.test(lower)) return false;
  const hasVerb = /\b(es|esta|son|estan|era|eran|fue|fueron|ha|han|habia|habian)\b/.test(lower);
  return !hasVerb;
}

function postProcessEsToDe(sourceText, translatedText) {
  const sourceNorm = normalizeEsText(sourceText);
  let out = String(translatedText || "").trim();
  if (!out) return "";
  if ((sourceNorm === "casa" || sourceNorm === "la casa") && /eigenheim/i.test(out)) out = "das Haus";
  if (sourceNorm === "casa" || sourceNorm === "la casa") out = "das Haus";
  if (sourceNorm === "la casa bonita") out = "das schöne Haus";
  if (sourceNorm === "la casa es bonita") out = "Das Haus ist schön";
  if (looksLikeSpanishNounPhrase(sourceText) && /\bist\b/i.test(out) && /\bhaus\b/i.test(out)) {
    out = out.replace(/^das\s+haus\s+ist\s+/i, "das ").replace(/^Das\s+Haus\s+ist\s+/i, "Das ");
  }
  if (/\b(casa propia|vivienda propia)\b/.test(sourceNorm) === false) {
    out = out.replace(/\b(Eigenheim|eigenheim)\b/g, "Haus");
  }
  return out.trim();
}

function isSingleWord(text = "") {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length === 1;
}
function setTranslateStatus(text = "", level = "info") {
  if (!elements.cardTranslateStatus) return;
  elements.cardTranslateStatus.textContent = text;
  elements.cardTranslateStatus.dataset.level = level;
}
function refreshTranslateCta() {
  if (!elements.cardTranslate) return;
  const hasAnyTarget = String(elements.cardBack?.value || "").trim() || String(elements.cardFront?.value || "").trim();
  elements.cardTranslate.textContent = hasAnyTarget ? "Retraducir" : "Traducir";
}
function normalizeSenses(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
}
async function translatePhrase(text, source, target, signal, { verify = true } = {}) {
  const q = String(text || "").trim();
  if (!q) return "";
  const cacheKey = `${source}:${target}:phrase:${q}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  let translated = await translateTextWithFallback({
    text: q,
    sourceLang: source,
    targetLang: target,
    mode: "phrase",
    signal,
    contextText: "",
  });

  if (!translated || (verify && translated.toLowerCase() === q.toLowerCase())) throw new Error("invalid translation");
  if (source === "es" && target === "de") translated = postProcessEsToDe(q, translated);
  if (translated.toLowerCase() === q.toLowerCase()) throw new Error("same-as-source");
  translationCache.set(cacheKey, translated);
  console.info("[translate:success]", { mode: "phrase", source, target, text: q, translated });
  return translated;
}
function detectNumberedLinePrefix(line) {
  const match = String(line || "").match(/^(\s*)(\d+)\.\s/);
  if (!match) return null;
  return { indent: match[1] || "", number: Number(match[2] || 0) };
}
function maybeSeedNumberedTextarea(event) {
  const textarea = event?.target;
  if (!textarea || textarea.value !== "") return;
  textarea.value = "1. ";
  textarea.setSelectionRange(3, 3);
}
function maybeHandleNumberedEnter(event) {
  const textarea = event?.target;
  if (!textarea || event.key !== "Enter") return;
  const value = textarea.value || "";
  const before = value.slice(0, textarea.selectionStart);
  const after = value.slice(textarea.selectionEnd);
  const line = before.split("\n").pop() || "";
  const marker = detectNumberedLinePrefix(line);
  if (!marker) return;
  event.preventDefault();
  const nextMarker = `\n${marker.indent}${marker.number + 1}. `;
  const nextValue = `${before}${nextMarker}${after}`;
  const pos = before.length + nextMarker.length;
  textarea.value = nextValue;
  textarea.setSelectionRange(pos, pos);
  autoResizeTextarea(textarea);
}
function autoResizeTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}
async function translateStructuredText(text, source, target, signal, contextText = "") {
  const clean = String(text || "").trim();
  if (!clean) return "";
  const lines = clean.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const marker = detectNumberedLinePrefix(line);
    const body = marker ? line.replace(/^(\s*)\d+\.\s/, "").trim() : line.trim();
    if (!body) { out.push(line); continue; }
    const translated = isSingleWord(body)
      ? await lookupWord(body, source, target, signal, contextText)
      : await translatePhrase(body, source, target, signal, { verify: true });
    const sanitized = marker ? String(translated || "").replace(/^\s*\d+\.\s*/, "").trim() : translated;
    out.push(marker ? `${marker.indent}${marker.number}. ${sanitized}` : translated);
  }
  return out.join("\n");
}
async function lookupWord(word, source, target, signal, contextText = "") {
  const clean = String(word || "").trim();
  if (!clean) return "";
  const contextKey = String(contextText || "").trim();
  const cacheKey = `${source}:${target}:word:${clean}:${contextKey}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  const translated = await translateTextWithFallback({
    text: clean,
    sourceLang: source,
    targetLang: target,
    mode: "word",
    signal,
    contextText,
  });
  if (!translated) throw new Error("invalid translation");
  translationCache.set(cacheKey, translated);
  console.info("[translate:success]", { mode: "word", source, target, word: clean, translated });
  return translated;
}
function updateCardLanguageLabels() {
  const { sourceLang, targetLang } = getActiveFolderLanguages();
  const sourceName = LANGUAGE_LABELS[sourceLang] || sourceLang.toUpperCase();
  const targetName = LANGUAGE_LABELS[targetLang] || targetLang.toUpperCase();
  if (elements.cardFrontLabel) elements.cardFrontLabel.textContent = `Frente (${sourceName})`;
  if (elements.cardBackLabel) elements.cardBackLabel.textContent = `Reverso (${targetName})`;
  LANGUAGE_INPUT_CLASSES.forEach((className) => {
    elements.cardFront?.classList.remove(className);
    elements.cardBack?.classList.remove(className);
  });
  elements.cardFront?.classList.add(`lang-bg-${sourceLang}`);
  elements.cardBack?.classList.add(`lang-bg-${targetLang}`);
}
async function runCardTranslation(direction, { force = false } = {}) {
  if (elements.cardType?.value !== "basic") return;
  if (cardTranslateAbortController) cardTranslateAbortController.abort();
  cardTranslateAbortController = new AbortController();
  const sourceText = direction === "es-de" ? elements.cardFront.value : elements.cardBack.value;
  const hasTarget = direction === "es-de" ? String(elements.cardBack.value || "").trim() : String(elements.cardFront.value || "").trim();
  if (hasTarget && !force) {
    const ok = window.confirm("El campo destino tiene texto. ¿Sobrescribir?");
    if (!ok) return;
  }
  setTranslateStatus("Traduciendo…");
  try {
    const { sourceLang, targetLang } = getActiveFolderLanguages();
    const source = direction === "source-target" ? sourceLang : targetLang;
    const target = direction === "source-target" ? targetLang : sourceLang;
    console.info("[translate:phrase]", { direction, source, target });
    const translated = await translateStructuredText(sourceText, source, target, cardTranslateAbortController.signal, elements.cardTranslateContext?.value || "");
    if (!isSingleWord(sourceText)) elements.cardTranslateContextField?.classList.add("hidden");
    if (direction === "es-de") { elements.cardBack.value = translated; autoResizeTextarea(elements.cardBack); }
    else { elements.cardFront.value = translated; autoResizeTextarea(elements.cardFront); }
    refreshTranslateCta();
    cardLastTranslation = translated;
    setTranslateStatus("Listo");
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("[translate:error]", err);
    setTranslateStatus("No se pudo traducir", "warn");
    showToast("No se pudo traducir", "info");
  }
}
function cleanTextForSpeech(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*(?:[-*•]+|\d+\s*(?:[.)]|-\s*))\s*/, "")
      .replace(/^\s*[|:;,.·-]+\s*/, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function speakText(text, lang) {
  if (!("speechSynthesis" in window)) return;
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return;
  const { locale, voice } = getVoiceForLanguage(lang);
  const utter = new SpeechSynthesisUtterance(cleaned.replace(/\n+/g, ". "));
  utter.lang = locale;
  if (voice) utter.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}
function buildAudioButton(text, lang, { label = "Reproducir audio" } = {}) {
  const btn = document.createElement("button");
  btn.className = "icon-button icon-button--compact";
  btn.type = "button";
  btn.textContent = "🔊";
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", () => speakText(text, lang));
  return btn;
}
function injectInlineSpeechButtons(contentEl, lang) {
  if (!contentEl) return false;
  const rawText = String(contentEl.innerText || "").replace(/\r/g, "");
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const numberedLineRegex = /^\s*(\d+)\.\s+(.+?)\s*$/;
  const numberedLines = lines
    .map((line) => {
      const match = line.match(numberedLineRegex);
      if (!match) return null;
      return { line, number: match[1], cleanText: cleanTextForSpeech(match[2]) };
    })
    .filter(Boolean);
  if (!numberedLines.length || numberedLines.length !== lines.length) return false;

  contentEl.textContent = "";
  const list = document.createElement("div");
  list.className = "inline-speech-list";
  numberedLines.forEach(({ line, cleanText }, index) => {
    const row = document.createElement("div");
    row.className = "inline-speech-row";
    const btn = buildAudioButton(cleanText, lang, { label: `Reproducir línea ${index + 1}` });
    btn.dataset.speechText = cleanText;
    row.appendChild(btn);
    const value = document.createElement("span");
    value.className = "inline-speech-row__text";
    value.textContent = line;
    row.appendChild(value);
    list.appendChild(row);
  });
  contentEl.appendChild(list);
  return true;
}

const ORDER_LABEL_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#f87171", "#22d3ee"];
const ORDER_DEFAULT_LABELS = ["Suj", "V", "CCL", "CD", "CI"];
const orderEditorState = {
  chunks: [],
  labelsCatalog: [],
  tokenLabels: {},
  selectedTokenIds: new Set(),
  activeLabelId: null,
};

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function parseOrderDelimitedInput(value) {
  const normalized = String(value || "").replace(/\r?\n/g, "||");
  return normalized
    .split("||")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractLanguageSegment(text, code) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const regex = new RegExp(`${code}\\s*:\\s*`, "i");
  const match = normalized.match(regex);
  if (!match || match.index === undefined) return "";
  const startIndex = match.index + match[0].length;
  const rest = normalized.slice(startIndex).trim();
  if (!rest) return "";
  const nextMatch = rest.match(/\b[A-Z]{2}\s*:/);
  if (nextMatch && nextMatch.index !== undefined) {
    return rest.slice(0, nextMatch.index).trim();
  }
  return rest;
}

function parseLegacyOrderTokens(front) {
  const normalized = String(front || "").replace(/\s+/g, " ").trim();
  if (!/^order\s*:/i.test(normalized)) return [];
  const tokenSection = normalized.replace(/^order\s*:\s*/i, "");
  return tokenSection
    .split("|")
    .map((token) => token.trim())
    .filter(Boolean);
}

function guessLegacyOrderAnswer(tokens, phrase) {
  const normalizedPhrase = String(phrase || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedPhrase) return null;
  const positions = tokens.map((token) => {
    const text = String(token.text || "").replace(/\s+/g, " ").trim().toLowerCase();
    return { id: token.id, index: normalizedPhrase.indexOf(text) };
  });
  if (positions.some((entry) => entry.index === -1)) return null;
  const uniquePositions = new Set(positions.map((entry) => entry.index));
  if (uniquePositions.size !== positions.length) return null;
  return positions.sort((a, b) => a.index - b.index).map((entry) => entry.id);
}

function buildLegacyOrderCard(card) {
  if (!card || card.type !== "basic") return null;
  const tokenTexts = parseLegacyOrderTokens(card.front || "");
  if (!tokenTexts.length) return null;
  const tokens = tokenTexts.map((text, index) => ({
    id: `t${index}`,
    text,
    label: "—",
  }));
  const spanish = extractLanguageSegment(card.back || "", "ES") || String(card.back || "").trim();
  const german = extractLanguageSegment(card.back || "", "DE");
  const guessedAnswer = guessLegacyOrderAnswer(tokens, german);
  const answer = guessedAnswer || tokens.map((token) => token.id);
  return {
    ...card,
    type: "order",
    front: spanish,
    orderTokens: tokens,
    orderAnswer: answer,
    orderLegacy: !guessedAnswer,
  };
}

function resolveLegacyOrderCard(card) {
  return buildLegacyOrderCard(card) || card;
}

function parseOrderTokenEntry(entry, index) {
  const parts = entry.split("::");
  if (parts.length > 1) {
    const candidateId = parts[0].trim();
    const text = parts.slice(1).join("::").trim();
    if (candidateId && text) {
      return { id: candidateId, text };
    }
  }
  return { id: `t${index}`, text: entry.trim() };
}

function buildOrderTokens(tokensInput, labelsInput, uiState = null) {
  const errors = [];
  const tokens = [];
  const idSet = new Set();
  let labelsCatalog = [];
  let tokenLabels = {};

  if (uiState?.chunks?.length) {
    labelsCatalog = (uiState.labelsCatalog || []).map((label) => ({
      id: label.id,
      text: label.text,
      color: label.color,
    }));
    tokenLabels = { ...(uiState.tokenLabels || {}) };
    uiState.chunks.forEach((chunk, index) => {
      let id = chunk.id || `t${index}`;
      if (idSet.has(id)) {
        id = `t${index}_${Math.random().toString(16).slice(2, 6)}`;
      }
      idSet.add(id);
      tokens.push({ id, text: chunk.text || "", label: "" });
    });
  } else {
    const tokensRaw = parseOrderDelimitedInput(tokensInput);
    const labelsRaw = parseOrderDelimitedInput(labelsInput);
    tokensRaw.forEach((tokenEntry, index) => {
      const parsed = parseOrderTokenEntry(tokenEntry, index);
      let id = parsed.id || `t${index}`;
      if (idSet.has(id)) {
        id = `t${index}_${Math.random().toString(16).slice(2, 6)}`;
      }
      idSet.add(id);
      tokens.push({
        id,
        text: parsed.text || "",
        label: labelsRaw[index] || "",
      });
    });
    labelsCatalog = labelsRaw.filter(Boolean).map((label, index) => ({
      id: `legacy_${index}`,
      text: label,
      color: ORDER_LABEL_COLORS[index % ORDER_LABEL_COLORS.length],
    }));
    tokenLabels = tokens.reduce((acc, token, index) => {
      if (!token.label) return acc;
      const found = labelsCatalog.find((label) => label.text === token.label);
      if (found) acc[token.id] = found.id;
      else acc[token.id] = `legacy_${index}`;
      return acc;
    }, {});
  }

  if (!tokens.length) {
    errors.push("Añade tokens/chunks para ordenar.");
  }

  const labelById = labelsCatalog.reduce((acc, label) => {
    acc[label.id] = label;
    return acc;
  }, {});
  const normalizedTokenLabels = {};
  tokens.forEach((token, index) => {
    const labelId = tokenLabels[token.id];
    if (labelId && labelById[labelId]) {
      normalizedTokenLabels[token.id] = labelId;
      token.label = labelById[labelId].text;
    } else if (token.label) {
      // compat legacy
      const compatLabel = labelsCatalog.find((label) => label.text === token.label);
      if (compatLabel) {
        normalizedTokenLabels[token.id] = compatLabel.id;
      } else {
        const fallbackId = `legacy_${index}`;
        normalizedTokenLabels[token.id] = fallbackId;
      }
    }
  });

  return {
    tokens,
    errors,
    labelsCatalog,
    tokenLabels: normalizedTokenLabels,
  };
}

function buildOrderAnswer(answerInput, tokens) {
  const errors = [];
  const trimmed = String(answerInput || "").trim();
  if (!trimmed) {
    errors.push("Añade una respuesta para la tarjeta ORDER.");
    return { answer: [], errors };
  }
  if (/^[\d,\s]+$/.test(trimmed)) {
    const indices = trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => Number(entry));
    if (indices.some((index) => !Number.isInteger(index))) {
      errors.push("ANSWER con índices inválidos.");
      return { answer: [], errors };
    }
    if (indices.length !== tokens.length) {
      errors.push("ANSWER debe incluir todos los tokens.");
      return { answer: [], errors };
    }
    if (indices.some((index) => index < 0 || index >= tokens.length)) {
      errors.push("ANSWER contiene índices fuera de rango.");
      return { answer: [], errors };
    }
    return { answer: indices.map((index) => tokens[index].id), errors };
  }
  const answerEntries = parseOrderDelimitedInput(trimmed);
  if (answerEntries.length !== tokens.length) {
    errors.push("ANSWER debe incluir todos los tokens.");
    return { answer: [], errors };
  }
  const tokensByText = tokens.reduce((acc, token) => {
    const key = token.text.trim();
    if (!acc[key]) acc[key] = [];
    acc[key].push(token.id);
    return acc;
  }, {});
  const idSet = new Set(tokens.map((token) => token.id));
  const answer = answerEntries.map((entry) => {
    if (idSet.has(entry)) return entry;
    const matches = tokensByText[entry] || [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      errors.push("ANSWER ambiguo: usa índices cuando hay tokens repetidos.");
      return null;
    }
    errors.push(`ANSWER contiene token desconocido: ${entry}`);
    return null;
  });
  return { answer: answer.filter(Boolean), errors };
}

function buildOrderAnswerInput(card) {
  const tokens = card?.orderTokens || [];
  const hasDuplicates = new Set(tokens.map((token) => token.text)).size !== tokens.length;
  if (hasDuplicates) {
    return (card.orderAnswer || [])
      .map((id) => tokens.findIndex((token) => token.id === id))
      .filter((index) => index >= 0)
      .join(",");
  }
  const tokenMap = tokens.reduce((acc, token) => {
    acc[token.id] = token.text;
    return acc;
  }, {});
  return (card.orderAnswer || []).map((id) => tokenMap[id] || id).join(" || ");
}

function formatOrderTokensInput(card) {
  return (card?.orderTokens || []).map((token) => token.text).join(" || ");
}

function formatOrderLabelsInput(card) {
  return (card?.orderTokens || []).map((token) => token.label || "").join(" || ");
}


function buildLegacyOrderLabelCompat(card) {
  const tokens = card?.orderTokens || [];
  if (!tokens.length) {
    return { labelsCatalog: [], tokenLabels: {} };
  }
  if (Array.isArray(card?.orderLabelsCatalog) && card?.orderLabelsCatalog.length && card?.orderTokenLabels) {
    return {
      labelsCatalog: card.orderLabelsCatalog,
      tokenLabels: card.orderTokenLabels,
    };
  }
  const legacyLabels = parseOrderDelimitedInput(card?.labels || "");
  if (!legacyLabels.length) {
    const uniqueFromTokens = [...new Set(tokens.map((token) => token.label).filter(Boolean))];
    const labelsCatalog = uniqueFromTokens.map((text, index) => ({
      id: `lbl_${index}`,
      text,
      color: ORDER_LABEL_COLORS[index % ORDER_LABEL_COLORS.length],
    }));
    const byText = labelsCatalog.reduce((acc, label) => {
      acc[label.text] = label.id;
      return acc;
    }, {});
    const tokenLabels = tokens.reduce((acc, token) => {
      const id = byText[token.label];
      if (id) acc[token.id] = id;
      return acc;
    }, {});
    return { labelsCatalog, tokenLabels };
  }
  if (legacyLabels.length !== tokens.length) {
    return { labelsCatalog: [], tokenLabels: {} };
  }
  const labelsCatalog = [];
  const labelByText = {};
  const tokenLabels = {};
  legacyLabels.forEach((text, index) => {
    if (!labelByText[text]) {
      const id = `lbl_${labelsCatalog.length}`;
      labelByText[text] = id;
      labelsCatalog.push({
        id,
        text,
        color: ORDER_LABEL_COLORS[labelsCatalog.length % ORDER_LABEL_COLORS.length],
      });
    }
    tokenLabels[tokens[index].id] = labelByText[text];
  });
  return { labelsCatalog, tokenLabels };
}

function hydrateOrderEditorState(card = null) {
  const resolved = resolveLegacyOrderCard(card || {});
  const tokens = (resolved?.orderTokens || []).map((token, index) => ({
    id: token.id || `t${index}`,
    text: token.text || "",
  }));
  const compat = buildLegacyOrderLabelCompat(resolved || {});
  const labelsCatalog = compat.labelsCatalog.length
    ? compat.labelsCatalog
    : ORDER_DEFAULT_LABELS.map((text, index) => ({
      id: `default_${index}`,
      text,
      color: ORDER_LABEL_COLORS[index % ORDER_LABEL_COLORS.length],
    }));
  const tokenLabels = { ...(compat.tokenLabels || {}) };
  orderEditorState.chunks = tokens;
  orderEditorState.labelsCatalog = labelsCatalog;
  orderEditorState.tokenLabels = tokenLabels;
  orderEditorState.selectedTokenIds = new Set();
  orderEditorState.activeLabelId = labelsCatalog[0]?.id || null;
}

function syncOrderHiddenFields() {
  if (elements.cardOrderTokens) {
    elements.cardOrderTokens.value = orderEditorState.chunks.map((chunk) => chunk.text).join(" || ");
  }
  if (elements.cardOrderLabels) {
    const labelMap = (orderEditorState.labelsCatalog || []).reduce((acc, label) => {
      acc[label.id] = label.text;
      return acc;
    }, {});
    elements.cardOrderLabels.value = orderEditorState.chunks
      .map((chunk) => labelMap[orderEditorState.tokenLabels[chunk.id]] || "")
      .join(" || ");
  }
  if (elements.cardOrderAnswer) {
    elements.cardOrderAnswer.value = orderEditorState.chunks.map((chunk) => chunk.id).join(",");
  }
}

function renderOrderEditor() {
  const tokenWrap = document.getElementById("card-order-token-chips");
  const labelWrap = document.getElementById("card-order-label-chips");
  if (!tokenWrap || !labelWrap) return;
  tokenWrap.innerHTML = "";
  labelWrap.innerHTML = "";
  const labelsById = (orderEditorState.labelsCatalog || []).reduce((acc, label) => {
    acc[label.id] = label;
    return acc;
  }, {});
  (orderEditorState.labelsCatalog || []).forEach((label) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `order-editor-chip${orderEditorState.activeLabelId === label.id ? " is-active" : ""}`;
    chip.dataset.labelId = label.id;
    chip.style.setProperty("--chip-color", label.color || "#60a5fa");
    chip.textContent = label.text;
    labelWrap.appendChild(chip);
  });
  (orderEditorState.chunks || []).forEach((chunk) => {
    const label = labelsById[orderEditorState.tokenLabels[chunk.id]];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `order-editor-token${orderEditorState.selectedTokenIds.has(chunk.id) ? " is-selected" : ""}`;
    chip.dataset.tokenId = chunk.id;
    if (label?.color) chip.style.setProperty("--token-label-color", label.color);
    chip.innerHTML = `<span class="order-editor-token__text"></span><span class="order-editor-token__label"></span>`;
    chip.querySelector(".order-editor-token__text").textContent = chunk.text;
    chip.querySelector(".order-editor-token__label").textContent = label?.text || "Sin label";
    tokenWrap.appendChild(chip);
  });
  syncOrderHiddenFields();
}

function getSafeAreaInset(side) {
  if (!side) return 0;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--safe-area-${side}`)
    .trim();
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReviewBuckets() {
  const next = {};
  Object.entries(state.reviewBuckets).forEach(([bucket, active]) => {
    const canonical = canonicalizeBucketId(bucket);
    if (!canonical) return;
    if (typeof next[canonical] === "undefined") {
      next[canonical] = Boolean(active);
    } else {
      next[canonical] = next[canonical] || Boolean(active);
    }
  });
  BUCKET_ORDER.forEach((bucket) => {
    if (typeof next[bucket] === "undefined") {
      next[bucket] = Boolean(state.reviewBuckets[bucket]);
    }
  });
  state.reviewBuckets = next;
}

normalizeReviewBuckets();

function resolveOwnedFolderId(value) {
  if (!value) return null;
  if (state.folders[value]) return value;
  const normalized = normalizeFolderPath(String(value || ""));
  const entries = Object.entries(state.folders || {});
  const byId = entries.find(([, folder]) => folder?.id === value);
  if (byId) return byId[0];
  const byPath = entries.find(([, folder]) => normalizeFolderPath(folder?.path || folder?.name || "") === normalized);
  if (byPath) return byPath[0];
  return null;
}

function getActiveFolderRef() {
  if (state.activeFolderRef?.folderId) {
    return state.activeFolderRef;
  }
  if (state.selectedFolderId) {
    return {
      ownerUid: state.username,
      folderId: state.selectedFolderId,
      role: "owner",
      isShared: false,
    };
  }
  return null;
}

function getActiveOwnerUid() {
  return getActiveFolderRef()?.ownerUid || state.username;
}

function isActiveFolderReadOnly() {
  const ref = getActiveFolderRef();
  if (!ref) return false;
  if (!ref.isShared) return false;
  return ref.role !== "editor";
}

function getFolderLabel(folder, ownerLabel, isShared = false) {
  if (!folder) return "Carpeta";
  if (!isShared) return folder.name || "Carpeta";
  return `${folder.name || "Carpeta"} · ${ownerLabel}`;
}

function getActiveFolderInfo() {
  const ref = getActiveFolderRef();
  if (!ref?.folderId) return null;
  if (!ref.isShared) {
    return state.folders[ref.folderId];
  }
  const shareKey = `${ref.ownerUid}_${ref.folderId}`;
  return state.sharedFolders?.[shareKey] || null;
}

function getUserLabel(uid) {
  const entry = state.usersPublic?.[uid];
  return entry?.displayName || entry?.handle || uid;
}

function getReviewCardContext(card = null) {
  return {
    ownerUid: card?._reviewOwnerUid || state.reviewFolderOwnerUid || state.username,
    role: card?._reviewRole || state.reviewFolderRole,
    isShared: card?._reviewIsShared || state.reviewFolderIsShared,
  };
}

function buildReviewFolderLabel() {
  const selections = getReviewFolderSelections();
  if (!selections.length) return "Todas";
  if (selections.length === 1) {
    const selection = selections[0];
    if (!selection.folderId) return "Todas";
    if (selection.isShared) {
      const sharedFolder = state.sharedFolders?.[selection.shareKey];
      const ownerLabel = getUserLabel(selection.ownerUid);
      return getFolderLabel(sharedFolder, ownerLabel, true);
    }
    return state.folders[selection.folderId]?.name || "Carpeta";
  }
  return `${selections.length} carpetas`;
}

function showOverlay(overlay, show) {
  overlay.classList.toggle("hidden", !show);
}

function showToast(message, type = "") {
  if (!elements.toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast${type ? ` ${type}` : ""}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 2500);
}

function handleErrorToast(error, fallbackMessage = "Ha ocurrido un error.") {
  const message = error?.message || String(error);
  showToast(message || fallbackMessage, "error");
  console.error(error);
}

function setStatus(text) {
  elements.status.textContent = text;
}

function setActiveScreen(name, { skipRouteSync = false } = {}) {
  const tabName = name === "cards" ? "folders" : name;
  elements.screens.forEach((screen) => {
    screen.classList.toggle("active", screen.id === `screen-${name}`);
  });
  elements.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.screen === tabName);
    if (tab.dataset.screen === tabName) {
      tab.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  });
  if (name !== "review") {
    setReviewMode(false);
  }
  if (!skipRouteSync) {
    syncRouteFromState(name);
  }
}

function closeAllMenus() {
  closeMenuPortal();
  document.querySelectorAll(".item-menu").forEach((menu) => {
    menu.classList.add("hidden");
  });
}

function closeMenuPortal() {
  if (menuPortalCleanup) {
    menuPortalCleanup();
    menuPortalCleanup = null;
  }
  if (menuPortal) {
    menuPortal.remove();
    menuPortal = null;
  }
  menuPortalAnchor = null;
}

function positionMenuPortal(portal, anchorRect) {
  if (!portal || !anchorRect) return;
  const menu = portal.querySelector(".menu-portal__menu");
  if (!menu) return;
  const menuRect = menu.getBoundingClientRect();
  const gap = 8;
  let top = anchorRect.bottom + gap;
  let left = anchorRect.right - menuRect.width;
  if (left < 8) left = 8;
  if (left + menuRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuRect.width - 8);
  }
  if (top + menuRect.height > window.innerHeight - 8) {
    top = anchorRect.top - menuRect.height - gap;
  }
  if (top < 8) top = 8;
  portal.style.top = `${top}px`;
  portal.style.left = `${left}px`;
}

function openMenuPortal(anchor, menuId) {
  const menu = document.querySelector(`[data-menu-id="${menuId}"]`);
  if (!menu || !anchor) return;
  closeMenuPortal();
  const portal = document.createElement("div");
  portal.className = "menu-portal";
  portal.dataset.menuId = menuId;
  const clone = menu.cloneNode(true);
  clone.classList.remove("hidden");
  clone.classList.add("menu-portal__menu");
  portal.appendChild(clone);
  document.body.appendChild(portal);
  const anchorRect = anchor.getBoundingClientRect();
  positionMenuPortal(portal, anchorRect);
  menuPortal = portal;
  menuPortalAnchor = anchor;
  const handleDismiss = (event) => {
    if (event.target.closest(".menu-portal")) return;
    if (event.target.closest("[data-menu-toggle]") === anchor) return;
    closeMenuPortal();
  };
  const handleReposition = () => {
    if (!menuPortalAnchor || !menuPortal) return;
    positionMenuPortal(menuPortal, menuPortalAnchor.getBoundingClientRect());
  };
  const handleScroll = () => closeMenuPortal();
  portal.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const folderId = actionEl.dataset.id;
    if (!action || !folderId) return;
    handleFolderMenuAction(action, folderId);
    closeMenuPortal();
  });
  document.addEventListener("click", handleDismiss);
  window.addEventListener("resize", handleReposition);
  window.addEventListener("scroll", handleScroll, true);
  menuPortalCleanup = () => {
    document.removeEventListener("click", handleDismiss);
    window.removeEventListener("resize", handleReposition);
    window.removeEventListener("scroll", handleScroll, true);
  };
}

function toggleMenu(menuId, anchor) {
  if (menuPortal && menuPortal.dataset.menuId === menuId) {
    closeMenuPortal();
    return;
  }
  openMenuPortal(anchor, menuId);
}

function setReviewMode(active) {
  if (elements.app) {
    elements.app.classList.toggle("review-mode", active);
  }
  if (elements.screenReviewConfig && elements.screenReviewPlayer) {
    elements.screenReviewConfig.classList.toggle("hidden", active);
    elements.screenReviewPlayer.classList.toggle("hidden", !active);
  }
}

function fnv1a32Hex(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function hashKey(value, length = 16) {
  const raw = String(value || "");
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, length);
  }
  return fnv1a32Hex(raw);
}

function tagsToMap(tags) {
  return tags.reduce((acc, tag) => {
    acc[tag] = true;
    return acc;
  }, {});
}

function mapToTags(map) {
  if (!map) return [];
  return Object.keys(map);
}

function splitTagInputValue(value) {
  const raw = String(value || "");
  const parts = raw.split(",");
  if (parts.length === 1) {
    return { tags: [], remainder: raw };
  }
  const remainder = parts.pop();
  const tags = normalizeTags(parts.join(","));
  return { tags, remainder };
}

function cardMatchesTagFilter(card, tags, mode = "or") {
  if (!tags.length) return true;
  const cardTags = mapToTags(card.tags);
  if (mode === "and") {
    return tags.every((tag) => cardTags.includes(tag));
  }
  return tags.some((tag) => cardTags.includes(tag));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCardText(value) {
  return String(value || "").replace(/\s*\|\s*/g, "\n");
}

const TERM_PUNCTUATION_REGEX = /^[.,;:!?()[\]{}"“”'’]+|[.,;:!?()[\]{}"“”'’]+$/g;
const WORD_TOKEN_REGEX = /[A-Za-zÀ-ÿÄÖÜäöüß]+(?:-[A-Za-zÀ-ÿÄÖÜäöüß]+)*/g;

function normalizeTerm(term) {
  return String(term || "")
    .trim()
    .toLowerCase()
    .replace(TERM_PUNCTUATION_REGEX, "");
}

function normalizeGlossaryEntries(glossary) {
  const entries = new Map();
  if (!glossary) return entries;
  if (Array.isArray(glossary)) {
    glossary.forEach((entry) => {
      const word = entry?.word || entry?.term || entry?.w || "";
      const meaning = entry?.meaning || entry?.m || "";
      const norm = normalizeWordCacheKey(word);
      if (norm && meaning) {
        entries.set(norm, meaning);
      }
    });
    return entries;
  }
  if (typeof glossary === "object") {
    Object.entries(glossary).forEach(([word, value]) => {
      const meaning = typeof value === "string" ? value : value?.meaning || value?.m || "";
      const norm = normalizeWordCacheKey(word);
      if (norm && meaning) {
        entries.set(norm, meaning);
      }
    });
  }
  return entries;
}

function getLexiconEntry(termKey) {
  if (!termKey) return null;
  const entry = state.lexicon?.[termKey];
  if (!entry) return null;
  if (typeof entry === "string") {
    return { meaning: entry };
  }
  return entry;
}

function resolveLexiconMeaning(termKey) {
  const entry = getLexiconEntry(termKey);
  return entry?.meaning || entry?.m || "";
}

function collectLexiconMatchesFromText(text, matches) {
  if (!text) return;
  const formatted = formatCardText(text);
  const regex = new RegExp(WORD_TOKEN_REGEX.source, "g");
  let match = regex.exec(formatted);
  while (match) {
    const termKey = normalizeTerm(match[0]);
    if (termKey) {
      const meaning = resolveLexiconMeaning(termKey);
      if (meaning) {
        matches.set(termKey, meaning);
      }
    }
    match = regex.exec(formatted);
  }
}

function buildGlossaryMap(card) {
  const lexiconMatches = new Map();
  const texts = [
    card?.front,
    card?.back,
    card?.clozeText,
    ...(card?.clozeAnswers || []),
  ];
  texts.forEach((text) => collectLexiconMatchesFromText(text, lexiconMatches));
  const glossaryMap = normalizeGlossaryEntries(card?.glossary);
  const merged = new Map(lexiconMatches);
  glossaryMap.forEach((entryMeaning, entryWord) => {
    merged.set(entryWord, entryMeaning);
  });
  return merged;
}

function resolveWordMeta(word, glossaryMap) {
  const norm = normalizeWordCacheKey(word);
  if (!norm) return { norm: "", meaning: "", gender: "" };
  const cached = state.glossaryCache.get(norm) || {};
  const entry = getLexiconEntry(norm) || {};
  return {
    norm,
    meaning: glossaryMap.get(norm) || cached.meaning || entry.meaning || "",
    gender: cached.gender || entry.gender || "",
  };
}

function buildTextFragment(text, glossaryMap) {
  const formatted = formatCardText(text);
  const fragment = document.createDocumentFragment();
  const regex = new RegExp(WORD_TOKEN_REGEX.source, "g");
  let lastIndex = 0;
  let match = regex.exec(formatted);
  while (match) {
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(formatted.slice(lastIndex, match.index)));
    }
    const word = match[0];
    const span = document.createElement("span");
    span.className = "word";
    const meta = resolveWordMeta(word, glossaryMap);
    if (meta.meaning && meta.meaning.trim()) span.classList.add("gloss-term", "has-meaning");
    if (meta.gender) span.classList.add(`word--${meta.gender}`);
    span.dataset.word = word;
    span.dataset.norm = meta.norm || "";
    span.dataset.gender = meta.gender || "";
    span.textContent = word;
    fragment.appendChild(span);
    lastIndex = match.index + word.length;
    match = regex.exec(formatted);
  }
  if (lastIndex < formatted.length) {
    fragment.appendChild(document.createTextNode(formatted.slice(lastIndex)));
  }
  return fragment;
}

function createLanguageChunk(text, language, glossaryMap) {
  const chunk = document.createElement("span");
  chunk.className = "lang-chunk";
  chunk.dataset.language = language;
  chunk.appendChild(buildTextFragment(text, glossaryMap));
  return chunk;
}

function renderTextWithLanguage(text, language, glossaryMap) {
  return createLanguageChunk(text, language, glossaryMap);
}

function renderBackWithLanguage(text, glossaryMap) {
  const fragment = document.createDocumentFragment();
  const markerIndex = text.toLowerCase().indexOf("es:");
  if (markerIndex === -1) {
    fragment.appendChild(renderTextWithLanguage(text, "es", glossaryMap));
    return fragment;
  }
  const before = text.slice(0, markerIndex);
  const after = text.slice(markerIndex);
  fragment.appendChild(renderTextWithLanguage(before, "de", glossaryMap));
  fragment.appendChild(renderTextWithLanguage(after, "es", glossaryMap));
  return fragment;
}

function parseMeaningInput(rawMeaning) {
  const tags = [];
  const tagRegex = /\(([^)]+)\)/g;
  let match = tagRegex.exec(rawMeaning);
  while (match) {
    const chunk = match[1]
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    tags.push(...chunk);
    match = tagRegex.exec(rawMeaning);
  }
  const cleanedMeaning = rawMeaning.replace(tagRegex, "").replace(/\s+/g, " ").trim();
  return {
    cleanedMeaning,
    tags: [...new Set(tags)],
  };
}

function refreshCurrentReviewCard() {
  const card = state.reviewQueue[state.currentIndex];
  if (!card) return;
  renderReviewCard(resolveLegacyOrderCard(card), state.reviewShowingBack);
}

async function ensureVocabFolderIds() {
  if (!state.username) return null;
  if (state.vocabFolderIds.deEs && state.vocabFolderIds.esDe) {
    return state.vocabFolderIds;
  }
  if (state.vocabFoldersPromise) {
    return state.vocabFoldersPromise;
  }
  state.vocabFoldersPromise = (async () => {
    const db = getDb();
    const folders = await ensureVocabFolders(db, state.username, state.folders);
    state.vocabFolderIds = folders;
    return folders;
  })();
  try {
    return await state.vocabFoldersPromise;
  } finally {
    state.vocabFoldersPromise = null;
  }
}

function normalizeWordCacheKey(word) {
  return normalizeTerm(word);
}

function buildCardGlossaryPayload(card, word, meaning) {
  const glossaryMap = normalizeGlossaryEntries(card?.glossary);
  const norm = normalizeWordCacheKey(word);
  if (norm) {
    glossaryMap.set(norm, meaning);
  }
  const payload = {};
  glossaryMap.forEach((entryMeaning, entryWord) => {
    payload[entryWord] = entryMeaning;
  });
  return payload;
}

function updateCardGlossaryLocal(cardId, glossary) {
  const updateCardLocal = (card) => {
    if (!card || card.id !== cardId) return card;
    return {
      ...card,
      glossary,
    };
  };
  state.reviewQueue = state.reviewQueue.map(updateCardLocal);
  state.cards = state.cards.map(updateCardLocal);
  state.cardsSearchPool = state.cardsSearchPool.map(updateCardLocal);
  if (state.cardCache.has(cardId)) {
    state.cardCache.set(cardId, {
      ...state.cardCache.get(cardId),
      glossary,
    });
  }
}

async function buildWordKey(word) {
  const norm = normalizeWordCacheKey(word);
  if (!norm) return "";
  return hashKey(norm, 24);
}

function openFolderModal(folder = null) {
  editingFolderId = folder ? folder.id : null;
  elements.folderModalTitle.textContent = folder ? "Editar carpeta" : "Nueva carpeta";
  elements.saveFolder.textContent = folder ? "Guardar" : "Crear";
  elements.folderNameInput.value = folder ? folder.name : "";
  if (elements.folderEmojiInput) elements.folderEmojiInput.value = folder?.emoji || "📁";
  if (elements.folderColorInput) elements.folderColorInput.value = folder?.color || "#8b5cf6";
  if (elements.folderBothSidesInput) elements.folderBothSidesInput.checked = Boolean(folder?.reviewBothSides);
  if (elements.folderSourceLang) elements.folderSourceLang.value = folder?.sourceLang || "es";
  if (elements.folderTargetLang) elements.folderTargetLang.value = folder?.targetLang || "de";
  elements.saveFolder.disabled = false;
  showOverlay(elements.folderModal, true);
  elements.folderNameInput.focus();
}

function closeFolderModal() {
  showOverlay(elements.folderModal, false);
  elements.folderNameInput.value = "";
  if (elements.folderEmojiInput) elements.folderEmojiInput.value = "📁";
  if (elements.folderColorInput) elements.folderColorInput.value = "#8b5cf6";
  if (elements.folderBothSidesInput) elements.folderBothSidesInput.checked = false;
  if (elements.folderSourceLang) elements.folderSourceLang.value = "es";
  if (elements.folderTargetLang) elements.folderTargetLang.value = "de";
  editingFolderId = null;
}

function renderBucketFilter() {
  if (!elements.reviewBucketChart) return;
  elements.reviewBucketChart.querySelectorAll(".bucket-bar").forEach((bar) => {
    const bucket = canonicalizeBucketId(bar.dataset.bucket);
    if (!bucket) return;
    const active = state.reviewBuckets[bucket];
    bar.classList.toggle("active", Boolean(active));
  });
}

function getCardDedupeValues(card) {
  const resolvedCard = resolveLegacyOrderCard(card);
  if (resolvedCard.type === "cloze") {
    return {
      front: resolvedCard.clozeText || "",
      back: (resolvedCard.clozeAnswers || []).join(" | "),
    };
  }
  if (resolvedCard.type === "order") {
    const tokens = resolvedCard.orderTokens || [];
    const tokenMap = tokens.reduce((acc, token) => {
      if (token?.id) acc[token.id] = token.text || "";
      return acc;
    }, {});
    const orderedTokens = (resolvedCard.orderAnswer || []).map((id) => tokenMap[id] || "");
    return {
      front: resolvedCard.front || "",
      back: orderedTokens.filter(Boolean).join(" | "),
    };
  }
  return {
    front: resolvedCard.front || "",
    back: resolvedCard.back || "",
  };
}

function buildCardListItem(card, isDuplicate, readOnly) {
  const item = document.createElement("div");
  const isSelected = state.selectedCardIds.has(card.id);
  const nounAccent = card?.cardGrammarType === "noun" && card?.nounGender ? ` list-item--${card.nounGender}` : "";
  item.className = `list-item${isDuplicate ? " is-dup" : ""}${isSelected ? " is-selected" : ""}${nounAccent}`;
  const resolvedCard = resolveLegacyOrderCard(card);
  const summary = resolvedCard.type === "cloze"
    ? `${resolvedCard.clozeText || "(cloze sin texto)"}`
    : resolvedCard.type === "order"
      ? `${resolvedCard.front || "(orden sin frente)"}`
      : `${resolvedCard.front}`;
  const verbConjCount = Array.isArray(resolvedCard.conjugationBlocks) ? resolvedCard.conjugationBlocks.length : 0;
  const detail = resolvedCard.type === "cloze"
    ? `Respuestas: ${(resolvedCard.clozeAnswers || []).join(", ") || "-"}`
    : resolvedCard.type === "order"
      ? `Orden: ${getCardDedupeValues(resolvedCard).back || "-"}`
      : (resolvedCard.cardGrammarType === "verb" && verbConjCount
        ? `${resolvedCard.back?.split("\n")[0] || "Verbo"} · ${verbConjCount} conjugaciones`
        : `${resolvedCard.back}`);
  item.innerHTML = `
      ${state.cardsSelectionMode ? `<button class="icon-button icon-button--compact" data-action="toggle-select" data-id="${card.id}" type="button" aria-label="Seleccionar">${isSelected ? "☑️" : "⬜"}</button>` : ""}
      <button class="item-main" data-action="edit" data-id="${card.id}" type="button">
        <span class="item-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect
              x="5"
              y="4.5"
              width="14"
              height="15"
              rx="2.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <path
              d="M8 9h8M8 12.5h6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <span class="item-text">
          <span class="item-title-row">
            <span class="item-title"></span>
            ${isDuplicate ? "<span class=\"dup-badge\">DUP</span>" : ""}
          </span>
          <span class="item-subtitle"></span>
        </span>
      </button>
      <div class="item-actions">
        <button class="icon-button icon-button--compact" data-action="edit" data-id="${card.id}" type="button" aria-label="Editar">✏️</button>
        <button class="icon-button icon-button--compact icon-button--danger" data-action="delete" data-id="${card.id}" type="button" aria-label="Borrar">🗑️</button>
      </div>
    `;
  const titleEl = item.querySelector(".item-title");
  if (titleEl) titleEl.textContent = formatCardText(summary);
  const subtitleEl = item.querySelector(".item-subtitle");
  if (subtitleEl) subtitleEl.textContent = formatCardText(detail);
  if (readOnly) {
    const actions = item.querySelector(".item-actions");
    if (actions) actions.remove();
  }
  return item;
}

function renderCards() {
  const list = elements.cardsList;
  list.innerHTML = "";
  const searchQuery = normalizeSearchQuery(state.cardsSearchQuery);
  const searching = Boolean(searchQuery);
  const searchSource = state.cardsSearchPool.length ? state.cardsSearchPool : state.cards;
  const filteredCards = searching
    ? searchSource.filter((card) => {
      const values = getCardDedupeValues(card);
      const front = normalizeSearchQuery(values.front);
      const back = normalizeSearchQuery(values.back);
      return front.includes(searchQuery) || back.includes(searchQuery);
    })
    : state.cards;
  if (!filteredCards.length) {
    if (!searching) {
      state.showOnlyDuplicates = false;
    }
    list.innerHTML = searching
      ? "<div class=\"card\">No hay tarjetas que coincidan con la búsqueda.</div>"
      : "<div class=\"card\">No hay tarjetas en esta carpeta.</div>";
    if (elements.cardsDupCount) {
      elements.cardsDupCount.textContent = "Duplicadas: 0";
    }
    if (elements.cardsDupToggle) {
      elements.cardsDupToggle.disabled = true;
      elements.cardsDupToggle.textContent = "Mostrar solo duplicadas";
    }
    updateLoadMoreVisibility(searching);
    return;
  }

  const frontCount = new Map();
  const backCount = new Map();
  filteredCards.forEach((card) => {
    const values = getCardDedupeValues(card);
    const normFront = normalizeText(values.front);
    const normBack = normalizeText(values.back);
    if (normFront) {
      frontCount.set(normFront, (frontCount.get(normFront) || 0) + 1);
    }
    if (normBack) {
      backCount.set(normBack, (backCount.get(normBack) || 0) + 1);
    }
  });

  const isDuplicateCard = (card) => {
    const values = getCardDedupeValues(card);
    const normFront = normalizeText(values.front);
    const normBack = normalizeText(values.back);
    return (
      (normFront && (frontCount.get(normFront) || 0) > 1)
      || (normBack && (backCount.get(normBack) || 0) > 1)
    );
  };

  const duplicateCards = filteredCards.filter((card) => isDuplicateCard(card));
  const visibleCards = state.showOnlyDuplicates ? duplicateCards : filteredCards;
  const duplicateCount = duplicateCards.length;

  if (elements.cardsDupCount) {
    elements.cardsDupCount.textContent = `Duplicadas: ${duplicateCount}`;
  }
  if (elements.cardsDupToggle) {
    elements.cardsDupToggle.disabled = duplicateCount === 0 && !state.showOnlyDuplicates;
    elements.cardsDupToggle.textContent = state.showOnlyDuplicates
      ? "Mostrar todas"
      : "Mostrar solo duplicadas";
  }

  if (!visibleCards.length) {
    list.innerHTML = state.showOnlyDuplicates
      ? "<div class=\"card\">No hay tarjetas duplicadas en esta carpeta.</div>"
      : "<div class=\"card\">No hay tarjetas en esta carpeta.</div>";
    return;
  }

  const readOnly = isActiveFolderReadOnly();
  visibleCards.forEach((card) => {
    const isDuplicate = isDuplicateCard(card);
    const item = buildCardListItem(card, isDuplicate, readOnly);
    list.appendChild(item);
  });
  updateLoadMoreVisibility(searching);
  updateCardsBulkToolbar();
}

function renderCardsListFiltered() {
  const query = normalizeSearchQuery(state.cardsSearchQuery);
  if (!query) {
    renderCards();
    return;
  }
  const filtered = state.cardsCache.filter((card) => {
    const values = getCardDedupeValues(card);
    const front = normalizeSearchQuery(values.front);
    const back = normalizeSearchQuery(values.back);
    return front.includes(query) || back.includes(query);
  });
  console.log("SEARCH", query, "matches", filtered.length);
  renderCardsFromList(filtered, true);
}

function renderCardsView() {
  if (state.cardsSearchQuery) {
    renderCardsListFiltered();
  } else {
    renderCards();
  }
}

function renderCardsFromList(cards, searching = false) {
  const list = elements.cardsList;
  list.innerHTML = "";
  const filteredCards = cards;
  if (!filteredCards.length) {
    if (!searching) {
      state.showOnlyDuplicates = false;
    }
    list.innerHTML = searching
      ? "<div class=\"card\">No hay tarjetas que coincidan con la búsqueda.</div>"
      : "<div class=\"card\">No hay tarjetas en esta carpeta.</div>";
    if (elements.cardsDupCount) {
      elements.cardsDupCount.textContent = "Duplicadas: 0";
    }
    if (elements.cardsDupToggle) {
      elements.cardsDupToggle.disabled = true;
      elements.cardsDupToggle.textContent = "Mostrar solo duplicadas";
    }
    updateLoadMoreVisibility(searching);
    return;
  }

  const frontCount = new Map();
  const backCount = new Map();
  filteredCards.forEach((card) => {
    const values = getCardDedupeValues(card);
    const normFront = normalizeText(values.front);
    const normBack = normalizeText(values.back);
    if (normFront) {
      frontCount.set(normFront, (frontCount.get(normFront) || 0) + 1);
    }
    if (normBack) {
      backCount.set(normBack, (backCount.get(normBack) || 0) + 1);
    }
  });

  const isDuplicateCard = (card) => {
    const values = getCardDedupeValues(card);
    const normFront = normalizeText(values.front);
    const normBack = normalizeText(values.back);
    return (
      (normFront && (frontCount.get(normFront) || 0) > 1)
      || (normBack && (backCount.get(normBack) || 0) > 1)
    );
  };

  const duplicateCards = filteredCards.filter((card) => isDuplicateCard(card));
  const visibleCards = state.showOnlyDuplicates ? duplicateCards : filteredCards;
  const duplicateCount = duplicateCards.length;

  if (elements.cardsDupCount) {
    elements.cardsDupCount.textContent = `Duplicadas: ${duplicateCount}`;
  }
  if (elements.cardsDupToggle) {
    elements.cardsDupToggle.disabled = duplicateCount === 0 && !state.showOnlyDuplicates;
    elements.cardsDupToggle.textContent = state.showOnlyDuplicates
      ? "Mostrar todas"
      : "Mostrar solo duplicadas";
  }

  if (!visibleCards.length) {
    list.innerHTML = state.showOnlyDuplicates
      ? "<div class=\"card\">No hay tarjetas duplicadas en esta carpeta.</div>"
      : "<div class=\"card\">No hay tarjetas en esta carpeta.</div>";
    return;
  }

  const readOnly = isActiveFolderReadOnly();
  visibleCards.forEach((card) => {
    const isDuplicate = isDuplicateCard(card);
    const item = buildCardListItem(card, isDuplicate, readOnly);
    list.appendChild(item);
  });
  updateLoadMoreVisibility(searching);
  updateCardsBulkToolbar();
}

function updateLoadMoreVisibility(searching = false) {
  if (!elements.loadMore) return;
  const shouldShow = Boolean(state.selectedFolderId)
    && state.cardsHasMore
    && !searching
    && state.cardsLoadMode === "paged";
  elements.loadMore.classList.toggle("hidden", !shouldShow);
  elements.loadMore.disabled = state.cardsLoadingMore || !shouldShow;
}

function openCardModal(card = null) {
  const resolvedCard = resolveLegacyOrderCard(card);
  const openedFromFoldersRoot = !resolvedCard && document.getElementById("screen-folders")?.classList.contains("active");
  state.cardModalOpenFromFoldersRoot = openedFromFoldersRoot;
  editingCardId = resolvedCard ? resolvedCard.id : null;
  elements.cardModalTitle.textContent = resolvedCard ? "Editar tarjeta" : "Nueva tarjeta";
  renderCardFolderSelector({
    openedFromFoldersRoot,
    selectedFolderId: resolvedCard?.folderId || state.cardModalLastSelectedFolderId || state.selectedFolderId || "",
    disableSelection: false,
  });
  const type = resolvedCard?.type || "basic";
  elements.cardType.value = type;
  elements.cardFront.value = resolvedCard ? resolvedCard.front || "" : "";
  elements.cardBack.value = resolvedCard ? resolvedCard.back || "" : "";
  const normalizedConjCard = ensureCardConjugationStructure(resolvedCard || {});
  if (normalizedConjCard?.conjugations && Object.keys(normalizedConjCard.conjugations).length) {
    const headings = Object.keys(normalizedConjCard.conjugations);
    elements.cardBack.dataset.conjugations = JSON.stringify(normalizedConjCard.conjugations);
    elements.cardBack.dataset.activeConjugationHeading = headings[0];
    elements.cardBack.value = normalizedConjCard.conjugations[headings[0]] || "";
  } else {
    delete elements.cardBack.dataset.conjugations;
    delete elements.cardBack.dataset.activeConjugationHeading;
  }
  if (elements.cardExample) elements.cardExample.value = resolvedCard ? resolvedCard.example || "" : "";
  currentGrammarType = resolvedCard?.cardGrammarType || "normal";
  cardNounGender = resolvedCard?.nounGender || null;
  elements.cardClozeText.value = resolvedCard ? resolvedCard.clozeText || "" : "";
  elements.cardClozeAnswers.value = resolvedCard ? (resolvedCard.clozeAnswers || []).join(" | ") : "";
  if (elements.cardOrderTokens) {
    elements.cardOrderTokens.value = resolvedCard ? formatOrderTokensInput(resolvedCard) : "";
  }
  if (elements.cardOrderLabels) {
    elements.cardOrderLabels.value = resolvedCard ? formatOrderLabelsInput(resolvedCard) : "";
  }
  if (elements.cardOrderAnswer) {
    elements.cardOrderAnswer.value = resolvedCard ? buildOrderAnswerInput(resolvedCard) : "";
  }
  cardFrontManuallyEdited = false;
  cardBackManuallyEdited = false;
  cardLastTranslation = "";
  hydrateOrderEditorState(resolvedCard);
  renderOrderEditor();
  elements.cardTags.value = "";
  state.selectedTags = new Set(mapToTags(resolvedCard?.tags || {}));
  renderTagPanels();
  updateTagSuggestions("card", "");
  updateCardTypeFields(type);
  syncGrammarControls();
  updateCardLanguageLabels();
  setTranslateStatus("");
  elements.cardTranslateEsDe?.classList.add("hidden");
  elements.cardTranslateDeEs?.classList.add("hidden");
  refreshTranslateCta();
  autoResizeTextarea(elements.cardFront);
  autoResizeTextarea(elements.cardBack);
  autoResizeTextarea(elements.cardExample);
  showOverlay(elements.cardModal, true);
}

function renderCardFolderSelector({ openedFromFoldersRoot = false, selectedFolderId = "", disableSelection = false } = {}) {
  if (!elements.cardFolderField || !elements.cardFolderSelect) return;
  const folders = Object.values(state.folders || {});
  const shouldShow = openedFromFoldersRoot || disableSelection;
  elements.cardFolderField.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;
  elements.cardFolderSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = folders.length ? "Selecciona carpeta…" : "Sin carpetas";
  elements.cardFolderSelect.appendChild(placeholder);
  folders.forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = `${folder.emoji || "📁"} ${folder.name || "Carpeta"}`;
    elements.cardFolderSelect.appendChild(option);
  });
  const resolvedSelection = folders.find((folder) => folder.id === selectedFolderId)?.id || "";
  elements.cardFolderSelect.value = resolvedSelection;
  elements.cardFolderSelect.disabled = disableSelection || !folders.length;
  elements.cardFolderEmptyMessage?.classList.toggle("hidden", folders.length > 0);
}

function ensureReviewEditModal() {
  if (reviewEditModal) return;
  reviewEditModal = document.createElement("div");
  reviewEditModal.className = "overlay review-edit-modal hidden";
  reviewEditModal.innerHTML = `
    <div class="modal modal-sheet">
      <div class="modal__header modal__header--sticky">
        <h2>Editar tarjeta</h2>
        <button class="icon-button" type="button" data-review-action="cerrar" aria-label="Cerrar">✕</button>
      </div>
      <div class="modal__body">
        <label class="field" data-review-field="basic-front">
          <span>Frente</span>
          <textarea rows="3"></textarea>
        </label>
        <label class="field" data-review-field="basic-back">
          <span>Reverso</span>
          <textarea rows="3"></textarea>
        </label>
        <label class="field hidden" data-review-field="cloze-text">
          <span>Texto cloze (usa ____ para el hueco)</span>
          <textarea rows="3"></textarea>
        </label>
        <label class="field hidden" data-review-field="cloze-answers">
          <span>Respuestas (separa con | )</span>
          <input type="text" placeholder="antwort | Antwort2" />
        </label>
        <label class="field hidden" data-review-field="order-tokens">
          <span>Tokens (separa con || )</span>
          <textarea rows="3" placeholder="ich || gehe || nach Hause"></textarea>
        </label>
        <label class="field hidden" data-review-field="order-labels">
          <span>Labels (separa con || )</span>
          <textarea rows="2" placeholder="Suj || V || CCL"></textarea>
        </label>
        <label class="field hidden" data-review-field="order-answer">
          <span>Respuesta (índices o tokens)</span>
          <input type="text" placeholder="0,1,2 o ich || gehe || nach Hause" />
        </label>
        <details class="order-help hidden" data-review-field="order-help">
          <summary>Ayuda: formato de ORDER</summary>
          <div class="order-help__content">
            <p><strong>Tokens</strong>: separados por <code>||</code>.</p>
            <p><strong>Labels</strong>: misma cantidad que tokens.</p>
            <p><strong>Answer</strong>: índices (0,1,2) o tokens en el orden correcto.</p>
            <p>Ejemplo:</p>
            <pre>ich || gehe || nach Hause</pre>
            <pre>Suj || V || CCL</pre>
            <pre>0,1,2</pre>
          </div>
        </details>
      </div>
      <div class="modal__footer modal__footer--sticky">
        <div class="row row--end">
          <button class="button ghost" type="button" data-review-action="cancelar">Cancelar</button>
          <button class="button" type="button" data-review-action="guardar">Guardar</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(reviewEditModal);
  const basicFrontField = reviewEditModal.querySelector("[data-review-field=\"basic-front\"]");
  const basicBackField = reviewEditModal.querySelector("[data-review-field=\"basic-back\"]");
  const clozeTextField = reviewEditModal.querySelector("[data-review-field=\"cloze-text\"]");
  const clozeAnswersField = reviewEditModal.querySelector("[data-review-field=\"cloze-answers\"]");
  const orderTokensField = reviewEditModal.querySelector("[data-review-field=\"order-tokens\"]");
  const orderLabelsField = reviewEditModal.querySelector("[data-review-field=\"order-labels\"]");
  const orderAnswerField = reviewEditModal.querySelector("[data-review-field=\"order-answer\"]");
  reviewEditOrderHelp = reviewEditModal.querySelector("[data-review-field=\"order-help\"]");
  reviewEditFront = basicFrontField.querySelector("textarea");
  reviewEditBack = basicBackField.querySelector("textarea");
  reviewEditClozeText = clozeTextField.querySelector("textarea");
  reviewEditClozeAnswers = clozeAnswersField.querySelector("input");
  reviewEditOrderTokens = orderTokensField.querySelector("textarea");
  reviewEditOrderLabels = orderLabelsField.querySelector("textarea");
  reviewEditOrderAnswer = orderAnswerField.querySelector("input");
  reviewEditCancel = reviewEditModal.querySelector("[data-review-action=\"cancelar\"]");
  reviewEditClose = reviewEditModal.querySelector("[data-review-action=\"cerrar\"]");
  reviewEditSave = reviewEditModal.querySelector("[data-review-action=\"guardar\"]");

  reviewEditCancel.addEventListener("click", closeReviewEditModal);
  reviewEditClose.addEventListener("click", closeReviewEditModal);
  reviewEditModal.addEventListener("click", (event) => {
    if (event.target === reviewEditModal) {
      closeReviewEditModal();
    }
  });
  reviewEditSave.addEventListener("click", handleReviewEditSave);
}

function openReviewEditModal(card) {
  if (!card) return;
  ensureReviewEditModal();
  const resolvedCard = resolveLegacyOrderCard(card);
  console.log("EDIT open", resolvedCard.id);
  reviewEditCardId = resolvedCard.id;
  const context = getReviewCardContext(resolvedCard);
  reviewEditOwnerUid = context.ownerUid;
  reviewEditRole = context.role;
  reviewEditIsShared = context.isShared;
  reviewEditType = resolvedCard.type || "basic";
  reviewEditFront.value = resolvedCard.front || "";
  reviewEditBack.value = resolvedCard.back || "";
  reviewEditClozeText.value = resolvedCard.clozeText || "";
  reviewEditClozeAnswers.value = (resolvedCard.clozeAnswers || []).join(" | ");
  if (reviewEditOrderTokens) {
    reviewEditOrderTokens.value = formatOrderTokensInput(resolvedCard);
  }
  if (reviewEditOrderLabels) {
    reviewEditOrderLabels.value = formatOrderLabelsInput(resolvedCard);
  }
  if (reviewEditOrderAnswer) {
    reviewEditOrderAnswer.value = buildOrderAnswerInput(resolvedCard);
  }
  const isCloze = reviewEditType === "cloze";
  const isOrder = reviewEditType === "order";
  reviewEditFront.closest(".field").classList.toggle("hidden", false);
  reviewEditBack.closest(".field").classList.toggle("hidden", isCloze || isOrder);
  reviewEditClozeText.closest(".field").classList.toggle("hidden", !isCloze);
  reviewEditClozeAnswers.closest(".field").classList.toggle("hidden", !isCloze);
  if (reviewEditOrderTokens) {
    reviewEditOrderTokens.closest(".field").classList.toggle("hidden", !isOrder);
  }
  if (reviewEditOrderLabels) {
    reviewEditOrderLabels.closest(".field").classList.toggle("hidden", !isOrder);
  }
  if (reviewEditOrderAnswer) {
    reviewEditOrderAnswer.closest(".field").classList.toggle("hidden", !isOrder);
  }
  if (reviewEditOrderHelp) {
    reviewEditOrderHelp.classList.toggle("hidden", !isOrder);
  }
  reviewEditModal.classList.remove("hidden");
  if (isCloze) {
    reviewEditClozeText.focus();
  } else if (isOrder && reviewEditOrderTokens) {
    reviewEditOrderTokens.focus();
  } else {
    reviewEditFront.focus();
  }
}

function closeReviewEditModal() {
  if (!reviewEditModal) return;
  reviewEditModal.classList.add("hidden");
  reviewEditCardId = null;
  reviewEditOwnerUid = null;
  reviewEditRole = null;
  reviewEditIsShared = false;
}

async function handleReviewEditSave() {
  if (!reviewEditCardId || !state.username) return;
  if (reviewEditIsShared && reviewEditRole !== "editor") {
    showToast("Carpeta compartida en solo lectura.", "error");
    return;
  }
  const db = getDb();
  const ownerUid = reviewEditOwnerUid || state.username;
  const nextFront = reviewEditFront.value.trim();
  const nextBack = reviewEditBack.value.trim();
  const nextClozeText = reviewEditClozeText.value.trim();
  const nextClozeAnswers = reviewEditClozeAnswers.value
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nextOrderTokensInput = reviewEditOrderTokens ? reviewEditOrderTokens.value : "";
  const nextOrderLabelsInput = reviewEditOrderLabels ? reviewEditOrderLabels.value : "";
  const nextOrderAnswerInput = reviewEditOrderAnswer ? reviewEditOrderAnswer.value : "";
  if (reviewEditType === "basic" && (!nextFront || !nextBack)) {
    showToast("Completa frente y reverso.", "error");
    return;
  }
  if (reviewEditType === "cloze") {
    if (!nextClozeText || !hasClozeMarker(nextClozeText)) {
      showToast("El cloze debe incluir ____ en el texto.", "error");
      return;
    }
    if (!nextClozeAnswers.length) {
      showToast("Añade al menos una respuesta.", "error");
      return;
    }
  }
  let orderTokens = [];
  let orderAnswer = [];
  let orderLabelsCatalog = [];
  let orderTokenLabels = {};
  let legacyOrderLabels = "";
  if (reviewEditType === "order") {
    if (!nextFront) {
      showToast("Completa FRONT_ES.", "error");
      return;
    }
    if (!nextBack) {
      showToast("Completa TARGET_DE.", "error");
      return;
    }
    const orderTokensResult = buildOrderTokens(nextOrderTokensInput, nextOrderLabelsInput);
    if (orderTokensResult.errors.length) {
      showToast(orderTokensResult.errors.join(" "), "error");
      return;
    }
    orderTokens = orderTokensResult.tokens;
    orderAnswer = orderTokens.map((token) => token.id);
    orderLabelsCatalog = orderTokensResult.labelsCatalog;
    orderTokenLabels = orderTokensResult.tokenLabels;
    legacyOrderLabels = elements.cardOrderLabels ? elements.cardOrderLabels.value : "";
  }
  try {
    const result = await updateCard(db, ownerUid, reviewEditCardId, {
      type: reviewEditType,
      front: nextFront,
      back: nextBack,
      clozeText: nextClozeText,
      clozeAnswers: nextClozeAnswers,
      orderTokens,
      orderAnswer,
      orderLabelsCatalog,
      orderTokenLabels,
      labels: legacyOrderLabels,
    });
    if (result?.status === "duplicate") {
      showToast("Duplicado omitido.");
      return;
    }
    const updateCardLocal = (card) => {
      if (!card || card.id !== reviewEditCardId) return card;
      return {
        ...card,
        type: reviewEditType,
        front: nextFront,
        back: nextBack,
        clozeText: nextClozeText,
        clozeAnswers: nextClozeAnswers,
        orderTokens,
        orderAnswer,
        orderLabelsCatalog,
        orderTokenLabels,
        labels: legacyOrderLabels,
      };
    };
    state.reviewQueue = state.reviewQueue.map(updateCardLocal);
    state.cards = state.cards.map(updateCardLocal);
    state.cardsSearchPool = state.cardsSearchPool.map(updateCardLocal);
    if (state.cardCache.has(reviewEditCardId)) {
      state.cardCache.set(reviewEditCardId, {
        ...state.cardCache.get(reviewEditCardId),
        type: reviewEditType,
        front: nextFront,
        back: nextBack,
        clozeText: nextClozeText,
        clozeAnswers: nextClozeAnswers,
        orderTokens,
        orderAnswer,
        orderLabelsCatalog,
        orderTokenLabels,
        labels: legacyOrderLabels,
      });
    }
    if (reviewEditType === "order") {
      state.reviewOrder = null;
    }
    refreshCurrentReviewCard();
    state.cardsCache = state.cards;
    renderCardsView();
    showToast("Tarjeta actualizada.");
    closeReviewEditModal();
    console.log("EDIT save ok");
  } catch (error) {
    handleErrorToast(error, "No se pudo guardar la tarjeta.");
  }
}

function closeCardModal() {
  showOverlay(elements.cardModal, false);
  editingCardId = null;
}

function toConjugationBlocksFromMap(conjugations = {}) {
  return Object.entries(conjugations || {}).map(([heading, body]) => ({
    heading,
    label: heading.replace(/^(?:INDIKATIV|KONJUNKTIV\s+[IⅡ1]+|IMPERATIV)\s*/i, "").trim() || heading,
    forms: parseGermanConjugationPaste(`${heading}\n${body}`)?.blocks?.[0]?.forms || {},
  }));
}

function ensureCardConjugationStructure(card = {}) {
  if (!card || card.cardGrammarType !== "verb") return card;
  if (card.conjugations && Object.keys(card.conjugations).length) return card;
  if (Array.isArray(card.conjugationBlocks) && card.conjugationBlocks.length) {
    const conjugations = Object.fromEntries(card.conjugationBlocks.map((b) => {
      const rows = ["ich", "du", "er/sie/es", "wir", "ihr", "sie"].map((p) => {
        const lbl = p === "er/sie/es" ? "er / sie / es" : (p === "sie" ? "sie / Sie" : p);
        return `${lbl} - ${b.forms?.[p] || "-"}`;
      }).join("\n");
      return [b.heading, rows];
    }));
    return { ...card, conjugations };
  }
  const parsed = parseGermanConjugationPaste(card.back || "");
  if (parsed?.blocks?.length) return { ...card, conjugations: parsed.conjugations, conjugationBlocks: parsed.blocks };
  return card;
}

function getCardConjugationBlocks(card = {}) {
  const normalized = ensureCardConjugationStructure(card);
  if (normalized.conjugations && Object.keys(normalized.conjugations).length) {
    return toConjugationBlocksFromMap(normalized.conjugations);
  }
  return Array.isArray(normalized.conjugationBlocks) ? normalized.conjugationBlocks : [];
}

function detectGermanVerbForReverso(text = "") {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const bracket = lines[0]?.match(/^\[([^\]]+)\]$/);
  if (bracket?.[1]) return bracket[1].trim().toLowerCase();
  for (const line of lines) {
    const match = line.match(/^(?:ich|du|er\/?sie\/?es|er\s*\/\s*sie\s*\/\s*es|wir|ihr|sie|Sie)\s+([a-zäöüß]+)\b/i);
    if (match?.[1] && /(en|n)$/i.test(match[1])) return match[1].toLowerCase();
  }
  return null;
}

function updateVerbReversoLink() {
  const verb = detectGermanVerbForReverso(elements.cardBack?.value || "");
  const href = verb
    ? `https://conjugador.reverso.net/conjugacion-aleman-verbo-${encodeURIComponent(verb)}.html`
    : "https://conjugador.reverso.net/conjugacion-aleman.html";
  if (elements.cardVerbReversoLink) elements.cardVerbReversoLink.href = href;
}

function applyReversoConjugationPaste(raw = "") {
  const parsed = parseGermanConjugationPaste(raw);
  if (!parsed) return;
  const firstHeading = Object.keys(parsed.conjugations || {})[0];
  elements.cardBack.value = firstHeading ? (parsed.conjugations[firstHeading] || "") : parsed.formatted;
  elements.cardBack.dataset.conjugations = JSON.stringify(parsed.conjugations || {});
  if (firstHeading) elements.cardBack.dataset.activeConjugationHeading = firstHeading;
  autoResizeTextarea(elements.cardBack);
  updateVerbReversoLink();
}

function syncGrammarControls() {
  elements.cardGrammarType?.querySelectorAll("[data-grammar-type]").forEach((btn) => {
    const isActive = btn.dataset.grammarType === currentGrammarType;
    btn.classList.toggle("active", isActive);
    btn.classList.toggle("is-active", isActive);
  });
  elements.cardVerbToolsField?.classList.toggle("hidden", currentGrammarType !== "verb");
  elements.cardNounToolsField?.classList.toggle("hidden", currentGrammarType !== "noun");
  elements.cardNounGenderField?.classList.toggle("hidden", currentGrammarType !== "noun");
  elements.cardNounGender?.querySelectorAll("[data-noun-gender]").forEach((btn) => {
    const isActive = btn.dataset.nounGender === cardNounGender;
    btn.classList.toggle("active", isActive);
    btn.classList.toggle("is-active", isActive);
  });
  console.info("[grammar:render]", { currentGrammarType, cardNounGender });
}

function setGrammarType(nextGrammarType = "normal") {
  const next = ["normal", "verb", "noun"].includes(nextGrammarType) ? nextGrammarType : "normal";
  const previous = currentGrammarType;
  currentGrammarType = next;
  cardNounGender = currentGrammarType === "noun" ? cardNounGender : null;
  if (elements.cardFront) elements.cardFront.value = "";
  if (elements.cardBack) elements.cardBack.value = currentGrammarType === "verb" ? VERB_TEMPLATE : "";
  if (elements.cardExample) elements.cardExample.value = "";
  autoResizeTextarea(elements.cardFront);
  autoResizeTextarea(elements.cardBack);
  autoResizeTextarea(elements.cardExample);
  console.info("[grammar:set]", { previous, next: currentGrammarType });
  syncGrammarControls();
  updateVerbReversoLink();
}

function updateCardTypeFields(type) {
  const isCloze = type === "cloze";
  const isOrder = type === "order";
  elements.cardBasicFrontField.classList.toggle("hidden", false);
  elements.cardBasicBackField.classList.toggle("hidden", isCloze);
  elements.cardClozeTextField.classList.toggle("hidden", !isCloze);
  elements.cardClozeAnswersField.classList.toggle("hidden", !isCloze);
  if (elements.cardOrderTokensField) {
    elements.cardOrderTokensField.classList.toggle("hidden", !isOrder);
  }
  if (elements.cardOrderLabelsField) {
    elements.cardOrderLabelsField.classList.toggle("hidden", !isOrder);
  }
  if (elements.cardOrderAnswerField) {
    elements.cardOrderAnswerField.classList.toggle("hidden", !isOrder);
  }
  if (elements.cardOrderHelp) {
    elements.cardOrderHelp.classList.toggle("hidden", !isOrder);
  }
}

function ensureWordPopover() {
  if (wordPopover) return;
  wordPopover = document.createElement("div");
  wordPopover.className = "word-popover hidden";
  wordPopover.innerHTML = `
    <div class="word-popover__title"></div>
    <button class="word-popover__meaning" type="button">
      <span class="meaning"></span>
    </button>
    <div class="word-popover__editor hidden">
      <div class="chip-toggle-group word-popover__genders">
        <button class="chip-toggle chip-toggle--der" data-gender="der" type="button">der</button>
        <button class="chip-toggle chip-toggle--die" data-gender="die" type="button">die</button>
        <button class="chip-toggle chip-toggle--das" data-gender="das" type="button">das</button>
      </div>
      <input type="text" class="word-popover__input" />
      <select class="word-popover__folder"></select>
      <button class="button small" type="button">Guardar</button>
    </div>
  `;
  document.body.appendChild(wordPopover);
  wordPopoverTitle = wordPopover.querySelector(".word-popover__title");
  wordPopoverMeaning = wordPopover.querySelector(".word-popover__meaning .meaning");
  wordPopoverEditor = wordPopover.querySelector(".word-popover__editor");
  wordPopoverInput = wordPopover.querySelector(".word-popover__input");
  wordPopoverSave = wordPopover.querySelector(".word-popover__editor .button");
  wordPopoverFolderSelect = wordPopover.querySelector(".word-popover__folder");
  wordPopoverGenderButtons = Array.from(wordPopover.querySelectorAll("[data-gender]"));

  wordPopover.querySelector(".word-popover__meaning").addEventListener("click", () => {
    if (!wordPopover || wordPopover.classList.contains("hidden")) return;
    wordPopoverEditing = true;
    wordPopoverEditor.classList.remove("hidden");
    wordPopoverInput.value = wordPopoverMeaning.textContent === "Añade significado…"
      ? ""
      : wordPopoverMeaning.textContent;
    wordPopoverInput.focus();
  });


  wordPopoverGenderButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      wordPopoverGenderButtons.forEach((entry) => entry.classList.remove("active", "is-active"));
      btn.classList.add("active", "is-active");
      wordPopover.dataset.gender = btn.dataset.gender || "";
    });
  });
  wordPopoverSave.addEventListener("click", async () => {
    const key = state.activeWordKey;
    const norm = state.activeWordNorm;
    if (!key || !state.username) return;
    const meaning = wordPopoverInput.value.trim();
    const termKey = normalizeTerm(wordPopoverTitle.textContent);
    const { cleanedMeaning, tags } = parseMeaningInput(meaning);
    try {
      const db = getDb();
      const selectedGender = wordPopover.dataset.gender || "";
      await upsertGlossaryEntries(db, state.username, [
        {
          key,
          word: wordPopoverTitle.textContent,
          meaning,
          tags: tagsToMap(tags),
          gender: selectedGender || null,
        },
      ]);
      if (termKey) {
        await upsertLexiconEntry(db, state.username, termKey, meaning);
        state.lexicon = {
          ...state.lexicon,
          [termKey]: {
            meaning,
            gender: selectedGender || null,
            updatedAt: Date.now(),
          },
        };
      }
      if (norm) {
        state.glossaryCache.set(norm, {
          key,
          word: wordPopoverTitle.textContent,
          meaning,
          gender: selectedGender || "",
          tags,
        });
      }
      if (state.activeWordContext?.cardId && meaning) {
        if (state.activeWordContext.isShared && state.activeWordContext.role !== "editor") {
          showToast("Solo el editor puede guardar glosario en la tarjeta.", "error");
        } else {
          const ownerUid = state.activeWordContext.ownerUid || state.username;
          const activeCard = state.reviewQueue.find((card) => card.id === state.activeWordContext.cardId)
            || state.cards.find((card) => card.id === state.activeWordContext.cardId);
          const nextGlossary = buildCardGlossaryPayload(activeCard, wordPopoverTitle.textContent, meaning);
          await updateCard(db, ownerUid, state.activeWordContext.cardId, {
            glossary: nextGlossary,
          });
          updateCardGlossaryLocal(state.activeWordContext.cardId, nextGlossary);
        }
      }
      showToast("Significado guardado.");
      wordPopoverEditing = false;
      wordPopoverEditor.classList.add("hidden");
      updateWordPopoverMeaning(meaning);
      {
        const folderId = wordPopoverFolderSelect?.value || "";
        if (folderId && cleanedMeaning) {
          await createOrUpdateVocabCard(db, state.username, {
            folderId,
            front: wordPopoverTitle.textContent,
            back: cleanedMeaning,
            tags: [...tags, "vocab"],
          });
        }
      }
      refreshCurrentReviewCard();
    } catch (error) {
      handleErrorToast(error, "No se pudo guardar el glosario.");
    }
  });
}

function updateWordPopoverMeaning(meaning) {
  if (!wordPopoverMeaning) return;
  wordPopoverMeaning.textContent = meaning ? meaning : "Añade significado…";
}

function positionWordPopover() {
  if (!wordPopover || !wordPopoverAnchor) return;
  if (wordPopoverEditing && document.activeElement === wordPopoverInput) return;
  const padding = 12;
  const safeTop = getSafeAreaInset("top");
  const safeBottom = getSafeAreaInset("bottom");
  const safeLeft = getSafeAreaInset("left");
  const safeRight = getSafeAreaInset("right");
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = wordPopover.getBoundingClientRect();
  let left = wordPopoverAnchor.left + wordPopoverAnchor.width / 2 - rect.width / 2;
  left = Math.max(padding + safeLeft, Math.min(left, viewportWidth - rect.width - padding - safeRight));

  let top = wordPopoverAnchor.top - rect.height - 8;
  if (top < padding + safeTop) {
    top = wordPopoverAnchor.bottom + 8;
  }
  top = Math.max(padding + safeTop, Math.min(top, viewportHeight - rect.height - padding - safeBottom));

  wordPopover.style.left = `${left}px`;
  wordPopover.style.top = `${top}px`;
}

function closeWordPopover() {
  if (!wordPopover) return;
  wordPopover.classList.add("hidden");
  wordPopoverEditor?.classList.add("hidden");
  wordPopoverEditing = false;
  state.activeWordKey = null;
  state.activeWordNorm = null;
  state.activeWordContext = null;
  wordPopoverAnchor = null;
}

async function openWordPopover(word, anchorRect) {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    return;
  }
  ensureWordPopover();
  const norm = normalizeWordCacheKey(word);
  const key = norm ? await buildWordKey(norm) : "";
  state.activeWordKey = key;
  state.activeWordNorm = norm;
  wordPopoverTitle.textContent = word;
  wordPopoverAnchor = anchorRect;
  wordPopoverEditor.classList.add("hidden");
  wordPopoverEditing = false;
  updateWordPopoverMeaning("");
  if (wordPopoverFolderSelect) {
    wordPopoverFolderSelect.innerHTML = "";
    const entries = Object.entries(state.folders || {});
    entries.forEach(([id, folder]) => {
      const op = document.createElement("option");
      op.value = id;
      op.textContent = folder?.name || id;
      wordPopoverFolderSelect.appendChild(op);
    });
  }
  wordPopover.dataset.gender = "";
  wordPopoverGenderButtons?.forEach((btn)=>btn.classList.remove("active","is-active"));
  wordPopover.classList.remove("hidden");
  positionWordPopover();
  const lexiconMeaning = norm ? resolveLexiconMeaning(norm) : "";
  if (lexiconMeaning) {
    updateWordPopoverMeaning(lexiconMeaning);
    positionWordPopover();
    return;
  }
  if (norm && state.glossaryCache.has(norm)) {
    const cached = state.glossaryCache.get(norm);
    updateWordPopoverMeaning(cached.meaning || "");
    positionWordPopover();
    return;
  }
  try {
    const db = getDb();
    const entry = await fetchGlossaryWord(db, state.username, key);
    if (entry) {
      const normalized = normalizeWordCacheKey(entry.wn || entry.w || word);
      state.glossaryCache.set(normalized, {
        key,
        word: entry.w || word,
        meaning: entry.m || entry.meaning || "",
        tags: entry.tags ? Object.keys(entry.tags) : [],
      });
      updateWordPopoverMeaning(entry.m || entry.meaning || "");
    } else {
      updateWordPopoverMeaning("");
  if (wordPopoverFolderSelect) {
    wordPopoverFolderSelect.innerHTML = "";
    const entries = Object.entries(state.folders || {});
    entries.forEach(([id, folder]) => {
      const op = document.createElement("option");
      op.value = id;
      op.textContent = folder?.name || id;
      wordPopoverFolderSelect.appendChild(op);
    });
  }
  wordPopover.dataset.gender = "";
  wordPopoverGenderButtons?.forEach((btn)=>btn.classList.remove("active","is-active"));
    }
    positionWordPopover();
  } catch (error) {
    handleErrorToast(error, "No se pudo cargar la palabra.");
  }
}

async function debugFolderSelection(folderId) {
  if (!state.username || !folderId) return;
  const activeRef = getActiveFolderRef();
  const ownerUid = activeRef?.ownerUid || state.username;
  console.log("selectedFolderId", folderId, "username", ownerUid);
  try {
    const db = getDb();
    const [sampleCards, folders] = await Promise.all([
      fetchSampleCards(db, ownerUid, 5),
      loadFolders(db, ownerUid),
    ]);
    sampleCards.forEach((card) => {
      console.log("sampleCard", { cardId: card.id, folderId: card.folderId, tags: Object.keys(card.tags || {}) });
    });
    const folderEntries = Object.values(folders || {}).map((entry) => ({
      id: entry.id,
      name: entry.name,
    }));
    console.log("foldersSnapshot", folderEntries);
  } catch (error) {
    handleErrorToast(error, "No se pudo cargar el diagnóstico.");
  }
}

async function runFolderIdMigration() {
  if (!state.username) return;
  try {
    const db = getDb();
    const result = await migrateLegacyCardFoldersOnce(db, state.username, 2000);
    console.log("MIGRATE folderIds", result);
  } catch (error) {
    handleErrorToast(error, "No se pudo migrar las carpetas.");
  }
}

async function runDedupeMigration() {
  if (!state.username) return;
  if (localStorage.getItem("chanki_migrated_dedupe_v2") === "1") return;
  try {
    const db = getDb();
    const result = await migrateDedupeV2Once(db, state.username);
    console.log("MIGRATE dedupe v2", result);
    localStorage.setItem("chanki_migrated_dedupe_v2", "1");
  } catch (error) {
    handleErrorToast(error, "No se pudo migrar los índices de duplicados.");
  }
}

async function loadInitialFolderCards() {
  const activeRef = getActiveFolderRef();
  if (!activeRef?.folderId) return;
  const db = getDb();
  const { ownerUid, folderId } = activeRef;
  const queueResult = await fetchCardsByFolderQueue(
    db,
    ownerUid,
    folderId,
    2000
  );
  if (queueResult.cards.length) {
    state.cards = queueResult.cards;
    state.cardsCache = queueResult.cards;
    state.cardsLoadedIds = new Set(queueResult.cards.map((card) => card.id));
    state.cardsHasMore = queueResult.hasMore;
    state.cardsPageCursor = null;
    state.cardsLoadMode = "queue";
    return;
  }
  const fallbackCards = await fetchCardsByFolderId(db, ownerUid, folderId, 500);
  if (fallbackCards.length) {
    state.cards = fallbackCards;
    state.cardsCache = fallbackCards;
    state.cardsLoadedIds = new Set(fallbackCards.map((card) => card.id));
    state.cardsHasMore = false;
    state.cardsPageCursor = null;
    state.cardsLoadMode = "folderId";
    return;
  }
  state.cardsLoadMode = "paged";
  await loadMoreCardsPage();
}

async function loadCards(reset = false) {
  if (!getActiveFolderRef()?.folderId) return;
  if (state.cardsLoadingMore) return;
  state.cardsLoadingMore = true;
  if (elements.loadMore) {
    elements.loadMore.disabled = true;
  }
  if (reset) {
    state.cards = [];
    state.cardsCache = [];
    state.cardsPageCursor = null;
    state.cardsHasMore = true;
    state.cardsLoadedIds = new Set();
    state.cardsLoadMode = "paged";
  }
  try {
    if (reset) {
      await loadInitialFolderCards();
    } else {
      await loadMoreCardsPage();
    }
    renderCardsView();
  } finally {
    state.cardsLoadingMore = false;
    if (elements.loadMore) {
      elements.loadMore.disabled = false;
    }
  }
}

function updateCardsTitle() {
  const activeRef = getActiveFolderRef();
  const folder = getActiveFolderInfo();
  if (!folder || !activeRef) {
    elements.cardsTitle.textContent = "Tarjetas";
    if (elements.cardsFolderMeta) {
      elements.cardsFolderMeta.textContent = "Selecciona una carpeta";
    }
    return;
  }
  const cardCount = Number(folder?.cardCount || 0);
  if (activeRef.isShared) {
    const ownerLabel = getUserLabel(activeRef.ownerUid);
    elements.cardsTitle.textContent = `${folder.emoji || "📁"} ${folder.name}`;
    if (elements.cardsFolderMeta) {
      elements.cardsFolderMeta.textContent = `${cardCount} tarjetas · compartida por ${ownerLabel}`;
    }
    return;
  }
  elements.cardsTitle.textContent = `${folder.emoji || "📁"} ${folder.name}`;
  if (elements.cardsFolderMeta) {
    elements.cardsFolderMeta.textContent = `${cardCount} tarjetas`;
  }
}

function updateSearchUI() {
  if (!elements.cardsSearchInput || !elements.cardsSearchClear) return;
  const query = state.cardsSearchQuery;
  const hasFolder = Boolean(state.selectedFolderId);
  elements.cardsSearchInput.value = query;
  elements.cardsSearchInput.disabled = !hasFolder;
  elements.cardsSearchClear.disabled = !hasFolder;
  elements.cardsSearchClear.classList.toggle("hidden", !query);
}

function updateFolderAccessUI() {
  const readOnly = isActiveFolderReadOnly();
  if (elements.addCard) {
    elements.addCard.disabled = readOnly;
  }
  if (elements.importFolder) {
    elements.importFolder.disabled = readOnly || !state.selectedFolderId;
  }
  if (elements.reviewEditCard) {
    elements.reviewEditCard.disabled = readOnly;
  }
}

function updateReviewAccessUI(card = null) {
  const context = getReviewCardContext(card);
  const readOnly = context.isShared && context.role !== "editor";
  if (elements.reviewActions) {
    elements.reviewActions.querySelectorAll("button").forEach((button) => {
      button.disabled = readOnly;
    });
  }
  if (elements.reviewEditCard) {
    elements.reviewEditCard.disabled = readOnly;
  }
}

function resetImportPreview() {
  if (!elements.importPreview) return;
  elements.importPreview.textContent = "";
  elements.importPreview.classList.remove("error");
  elements.importPreview.dataset.parsed = "";
}

function setImportContext(mode, options = {}) {
  importState.mode = mode;
  importState.forcedFolderId = options.forcedFolderId || null;
  importState.forcedFolderLabel = options.forcedFolderLabel || null;
  importState.sourceScreen = options.sourceScreen || "import";
  if (elements.importContext) {
    elements.importContext.classList.toggle("hidden", mode !== "folder");
  }
  if (elements.importDestination) {
    elements.importDestination.textContent = importState.forcedFolderLabel
      ? `${importState.forcedFolderLabel} (bloqueado)`
      : "Esta carpeta (bloqueado)";
  }
  if (elements.importWarning) {
    elements.importWarning.textContent = mode === "folder"
      ? "Si el texto contiene FOLDER: se ignorará y se importará aquí."
      : "";
  }
  if (elements.importSave) {
    elements.importSave.textContent = mode === "folder" ? "Importar aquí" : "Importar";
  }
  renderImportFolderSelect();
}

function renderImportFolderSelect() {
  if (!elements.importFolderSelect) return;
  const select = elements.importFolderSelect;
  const currentValue = select.value;
  const options = [
    '<option value="__none__">Sin carpeta</option>',
    ...Object.entries(state.folders || {})
      .map(([id, folder]) => ({ id, folder }))
      .sort((a, b) => String(a.folder?.name || "").localeCompare(String(b.folder?.name || ""), "es"))
      .map(({ id, folder }) => `<option value="${id}">${escapeHtml(folder?.emoji || "📁")} ${escapeHtml(folder?.name || "Carpeta")}</option>`),
  ];
  select.innerHTML = options.join("");
  if (importState.mode === "folder") {
    select.value = importState.forcedFolderId || "__none__";
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (currentValue && select.querySelector(`option[value="${CSS.escape(currentValue)}"]`)) {
    select.value = currentValue;
  } else {
    select.value = "__none__";
  }
}

function resolveBlockFolderPath(block, fallback) {
  return normalizeFolderPath(block?.folderPath || "") || fallback;
}

function buildImportPreview(parsed, options = {}) {
  const blocks = parsed.blocks || [];
  const errors = parsed.errors || [];
  const glossaryCount = parsed.glossary?.length || 0;
  const cardCount = blocks.reduce((total, block) => total + block.cards.length, 0);
  if (options.mode === "folder") {
    const lines = [`Se importarán ${cardCount} tarjetas en esta carpeta.`];
    if (glossaryCount) {
      lines.push(`Se añadirán ${glossaryCount} entradas al glosario.`);
    }
    if (errors.length) {
      lines.push("Errores detectados:");
      errors.forEach((error) => lines.push(`- Línea ${error.line}: ${error.message}`));
    }
    return { text: lines.join("\n"), cardCount, folderCount: 0 };
  }
  const folderFallback = options.folderFallback || "Importadas";
  const folderPaths = new Set(
    blocks.map((block) => resolveBlockFolderPath(block, folderFallback)).filter(Boolean)
  );
  const lines = [
    `Se crearán/actualizarán ${folderPaths.size} carpetas.`,
    `Se importarán ${cardCount} tarjetas.`,
  ];
  if (glossaryCount) {
    lines.push(`Se añadirán ${glossaryCount} entradas al glosario.`);
  }
  if (errors.length) {
    lines.push("Errores detectados:");
    errors.forEach((error) => lines.push(`- Línea ${error.line}: ${error.message}`));
  }
  return { text: lines.join("\n"), cardCount, folderCount: folderPaths.size };
}

function findFolderIdByImportPath(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return null;
  const name = normalized.split("/").pop()?.toLowerCase() || "";
  return Object.values(state.folders || {}).find((folder) =>
    String(folder?.name || "").trim().toLowerCase() === name
  )?.id || null;
}

function getCardRepetitions(card) {
  return card?.srs?.repetitions ?? card?.srs?.reps ?? 0;
}

function isEasyAllowed(card) {
  return getCardRepetitions(card) >= 3;
}

function updateReviewRatingButtons(card) {
  if (!elements.reviewActions) return;
  const context = getReviewCardContext(card);
  const readOnly = context.isShared && context.role !== "editor";
  const easyButton = elements.reviewActions.querySelector("[data-rating=\"easy\"]");
  if (!easyButton) return;
  const allowed = isEasyAllowed(card);
  easyButton.disabled = readOnly || !allowed;
  easyButton.classList.toggle("is-disabled", !allowed);
}

async function loadSearchPool() {
  if (!state.username || !state.cardsSearchQuery) return;
  if (state.cardsSearchLoading) return;
  const activeRef = getActiveFolderRef();
  if (!activeRef) return;
  const { ownerUid, folderId } = activeRef;
  if (
    state.cardsSearchPool.length
    && state.cardsSearchFolderId === folderId
    && state.cardsSearchOwnerUid === ownerUid
  ) {
    return;
  }
  state.cardsSearchLoading = true;
  try {
    const db = getDb();
    const cards = await fetchCardsForSearch(db, ownerUid, folderId, 200);
    state.cardsSearchPool = cards;
    state.cardsSearchFolderId = folderId;
    state.cardsSearchOwnerUid = ownerUid;
    renderCards();
  } catch (error) {
    handleErrorToast(error, "No se pudo buscar tarjetas.");
  } finally {
    state.cardsSearchLoading = false;
  }
}

function updateCardsSearch(value) {
  state.cardsSearchQuery = normalizeSearchQuery(value);
  if (!state.cardsSearchQuery) {
    state.cardsSearchPool = [];
    state.cardsSearchFolderId = null;
    state.cardsSearchOwnerUid = null;
  }
  updateSearchUI();
  renderCardsListFiltered();
}

function initCardCountsListener() {
  if (cardsCountUnsubscribe) {
    cardsCountUnsubscribe();
    cardsCountUnsubscribe = null;
  }
  if (!state.username) {
    state.folderCardCounts = {};
    renderFolders();
    return;
  }
  const db = getDb();
  cardsCountUnsubscribe = listenCardsByUser(db, state.username, (cardsMap) => {
    const counts = {};
    const allCards = Object.values(cardsMap || {}).filter(Boolean);
    allCards.forEach((card) => {
      const folderId = card?.folderId;
      if (!folderId) return;
      counts[folderId] = (counts[folderId] || 0) + 1;
    });
    state.folderCardCounts = counts;
    state.allCards = allCards;
    const validIds = new Set(allCards.map((card) => card.id));
    state.allCardsSelectedIds = new Set([...state.allCardsSelectedIds].filter((id) => validIds.has(id)));
    renderFolders();
    if (document.getElementById("screen-all-cards")?.classList.contains("active")) {
      renderAllCardsView();
    }
  });
}

async function initFolders() {
  if (activeUnsubscribe) {
    activeUnsubscribe();
  }
  if (!state.username) {
    state.folders = {};
    renderFolders();
    return;
  }
  const db = getDb();
  activeUnsubscribe = listenFolders(db, state.username, () => {
    loadFolders(db, state.username)
      .then((folders) => {
        state.folders = folders || {};
        renderFolders();
        renderImportFolderSelect();
      })
      .catch((error) => {
        console.error("No se pudo cargar carpetas", error);
        state.folders = {};
        renderFolders();
        renderImportFolderSelect();
      });
  });
}

function cleanupSharedFolderListeners(nextKeys) {
  sharedFolderListeners.forEach((unsubscribe, key) => {
    if (!nextKeys.has(key)) {
      unsubscribe();
      sharedFolderListeners.delete(key);
    }
  });
}

async function initSharedFolders() {
  if (sharedFoldersUnsubscribe) {
    sharedFoldersUnsubscribe();
    sharedFoldersUnsubscribe = null;
  }
  if (!state.username) {
    state.sharedFolders = {};
    state.sharedFolderRefs = {};
    sharedFolderListeners.forEach((unsubscribe) => unsubscribe());
    sharedFolderListeners.clear();
    renderFolders();
    return;
  }
  const db = getDb();
  sharedFoldersUnsubscribe = listenSharedFoldersByUser(db, state.username, (sharedRefs) => {
    const refs = sharedRefs || {};
    state.sharedFolderRefs = refs;
    const nextKeys = new Set(Object.keys(refs));
    cleanupSharedFolderListeners(nextKeys);
    Object.keys(state.sharedFolders || {}).forEach((key) => {
      if (!nextKeys.has(key)) {
        delete state.sharedFolders[key];
      }
    });
    Object.entries(refs).forEach(([shareKey, entry]) => {
      if (state.sharedFolders?.[shareKey]) {
        state.sharedFolders[shareKey] = {
          ...state.sharedFolders[shareKey],
          ...entry,
        };
      }
      if (sharedFolderListeners.has(shareKey)) return;
      const ownerUid = entry?.ownerUid;
      const folderId = entry?.folderId;
      if (!ownerUid || !folderId) return;
      const unsubscribe = listenFolderById(db, ownerUid, folderId, (folder) => {
        state.sharedFolders[shareKey] = {
          ...entry,
          ownerUid,
          folderId,
          id: folderId,
          name: folder?.name || "(Carpeta compartida)",
          cardCount: folder?.cardCount,
          updatedAt: folder?.updatedAt,
        };
        renderFolders();
        if (
          state.activeFolderRef?.isShared
          && state.activeFolderRef.ownerUid === ownerUid
          && state.activeFolderRef.folderId === folderId
        ) {
          updateCardsTitle();
          state.activeFolderRef = {
            ...state.activeFolderRef,
            role: entry?.role || state.activeFolderRef.role,
          };
          updateFolderAccessUI();
        }
      });
      sharedFolderListeners.set(shareKey, unsubscribe);
    });
    nextKeys.forEach((key) => {
      if (!state.sharedFolders[key]) {
        state.sharedFolders[key] = {
          ...refs[key],
          ownerUid: refs[key]?.ownerUid,
          folderId: refs[key]?.folderId,
          id: refs[key]?.folderId,
          name: "(Carpeta compartida)",
          path: "",
        };
      }
    });
    if (state.activeFolderRef?.isShared) {
      const activeKey = `${state.activeFolderRef.ownerUid}_${state.activeFolderRef.folderId}`;
      if (!refs[activeKey]) {
        state.activeFolderRef = null;
        state.selectedFolderId = null;
        state.cards = [];
        state.cardsCache = [];
        state.cardsSearchQuery = "";
        state.cardsSearchPool = [];
        state.cardsSearchFolderId = null;
        state.cardsSearchOwnerUid = null;
        updateCardsTitle();
        updateSearchUI();
        renderCards();
      } else if (refs[activeKey]?.role) {
        state.activeFolderRef = {
          ...state.activeFolderRef,
          role: refs[activeKey].role,
        };
        updateFolderAccessUI();
      }
    }
    renderFolders();
  });
}

async function loadUsersPublic() {
  if (!state.username) return;
  const db = getDb();
  try {
    const users = await fetchUsersPublic(db);
    state.usersPublic = users || {};
    renderFolders();
  } catch (error) {
    handleErrorToast(error, "No se pudo cargar usuarios.");
  }
}

async function syncUsersPublic() {
  if (!state.username) return;
  try {
    const db = getDb();
    await upsertUserPublic(db, state.username, {
      handle: state.username,
      displayName: state.username,
    });
    await loadUsersPublic();
  } catch (error) {
    handleErrorToast(error, "No se pudo actualizar el perfil público.");
  }
}

function getFolderDescendantIds(folderId, all = state.folders || {}) {
  const out = new Set();
  const walk = (id) => {
    Object.values(all).forEach((f) => {
      if ((f?.parentId || null) === id && f.id) { out.add(f.id); walk(f.id); }
    });
  };
  walk(folderId);
  return out;
}
async function moveFolderToParent(folderId, targetParentId) {
  if (!folderId || !state.folders[folderId]) return;
  if (folderId === targetParentId) return showToast("Movimiento inválido.", "error");
  const descendants = getFolderDescendantIds(folderId);
  if (targetParentId && descendants.has(targetParentId)) return showToast("No se puede mover dentro de una descendiente.", "error");
  const db = getDb();
  await updateFolder(db, state.username, folderId, { parentId: targetParentId || null });
  showToast("Carpeta movida.");
}
async function moveFoldersToParent(folderIds, targetParentId) {
  const selected = folderIds.filter((id) => state.folders[id]);
  for (const folderId of selected) {
    const descendants = getFolderDescendantIds(folderId);
    if (folderId === targetParentId || (targetParentId && descendants.has(targetParentId))) continue;
    await moveFolderToParent(folderId, targetParentId || null);
  }
}
function setFolderSelectionMode(active) {
  state.folderSelectionMode = !!active;
  if (!active) state.selectedFolderIds = new Set();
  if (elements.folderBulkBar) elements.folderBulkBar.classList.toggle("hidden", !active);
  const count = state.selectedFolderIds.size;
  if (elements.folderSelectedCount) elements.folderSelectedCount.textContent = `${count} seleccionadas`;
  if (elements.folderSelectToggle) elements.folderSelectToggle.textContent = active ? "Cancelar selección" : "Seleccionar";
  renderFolders();
}
function handleFolderDragStart(event) { const row = event.target.closest("[data-folder-id]"); if (!row) return; state.movingFolderId = row.dataset.folderId; event.dataTransfer.effectAllowed = "move"; row.classList.add("is-dragging"); }
function handleFolderDragOver(event) { const row = event.target.closest("[data-folder-id]"); if (!row) return; event.preventDefault(); row.classList.add("is-drop-target"); }
async function handleFolderDrop(event) { const row = event.target.closest("[data-folder-id]"); if (!row) return; event.preventDefault(); document.querySelectorAll(".folder-row").forEach((el)=>el.classList.remove("is-drop-target")); if (!state.movingFolderId) return; await moveFolderToParent(state.movingFolderId, row.dataset.folderId || null); }

function handleAddFolder() {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    return;
  }
  openFolderModal();
}

async function handleFolderMenuAction(action, folderId) {
  const db = getDb();
  if (action === "rename") {
    if (!state.folders[folderId]) {
      showToast("Solo el owner puede renombrar.", "error");
      return;
    }
    const folder = state.folders[folderId];
    if (folder) {
      openFolderModal(folder);
    }
  }
  if (action === "delete") {
    if (!state.folders[folderId]) {
      showToast("Solo el owner puede borrar.", "error");
      return;
    }
    const confirmDelete = confirm("¿Seguro? Esto no borra tarjetas asociadas.");
    if (confirmDelete) {
      try {
        await deleteFolder(db, state.username, folderId);
        showToast("Guardado");
        if (state.selectedFolderId === folderId) {
          state.selectedFolderId = null;
          state.activeFolderRef = null;
          state.cards = [];
          state.cardsHasMore = false;
          state.cardsSearchQuery = "";
          state.cardsSearchPool = [];
          state.cardsSearchFolderId = null;
          state.cardsSearchOwnerUid = null;
          updateSearchUI();
          renderCards();
          setActiveScreen("folders");
        }
      } catch (error) {
        handleErrorToast(error, "Error al borrar carpeta.");
      }
    }
  }
  if (action === "share") {
    if (!state.folders[folderId]) {
      showToast("Solo el owner puede compartir.", "error");
      return;
    }
    const folder = state.folders[folderId];
    if (folder) {
      openShareModal(folder);
    }
  }
}

async function handleFolderAction(event) {
  const menuToggle = event.target.closest("[data-menu-toggle]");
  if (menuToggle) {
    toggleMenu(menuToggle.dataset.menuToggle, menuToggle);
    return;
  }
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  const folderId = actionEl.dataset.id;
  if (!action) return;
  closeAllMenus();
  if (action === "browse-root") { state.folderBrowseId = null; renderFolders(); return; }
  if (action === "browse-up") {
    const current = state.folders?.[state.folderBrowseId || ""];
    state.folderBrowseId = current?.parentId || null;
    renderFolders();
    return;
  }
  if (!folderId) return;
  if (action === "browse") { state.folderBrowseId = folderId; renderFolders(); return; }
  if (action === "toggle-folder-select") {
    if (state.selectedFolderIds.has(folderId)) state.selectedFolderIds.delete(folderId);
    else state.selectedFolderIds.add(folderId);
    if (elements.folderSelectedCount) elements.folderSelectedCount.textContent = `${state.selectedFolderIds.size} seleccionadas`;
    renderFolders();
    return;
  }
  if (action === "select") {
    if (suppressNextFolderSelect) {
      suppressNextFolderSelect = false;
      return;
    }
    if (state.folderSelectionMode) {
      if (state.selectedFolderIds.has(folderId)) state.selectedFolderIds.delete(folderId);
      else state.selectedFolderIds.add(folderId);
      if (elements.folderSelectedCount) elements.folderSelectedCount.textContent = `${state.selectedFolderIds.size} seleccionadas`;
      renderFolders();
      return;
    }
    const ownerUid = actionEl.dataset.ownerUid || state.username;
    const isShared = actionEl.dataset.shared === "true";
    const role = actionEl.dataset.role || (isShared ? "viewer" : "owner");
    const resolvedFolderId = isShared ? folderId : (resolveOwnedFolderId(folderId) || folderId);
    debugFolderSelection(folderId);
    await openFolderView({ ownerUid, folderId: resolvedFolderId, role, isShared }, "push");
  }
  if (action === "rename" || action === "delete" || action === "share") {
    handleFolderMenuAction(action, folderId);
  }
}
let folderLongPressTimer = null;
let suppressNextFolderSelect = false;
function handleFolderLongPressStart(event) {
  const actionEl = event.target.closest("[data-action='select']");
  if (!actionEl || state.folderSelectionMode) return;
  const folderId = actionEl.dataset.id;
  if (!folderId) return;
  folderLongPressTimer = window.setTimeout(() => {
    setFolderSelectionMode(true);
    state.selectedFolderIds.add(folderId);
    suppressNextFolderSelect = true;
    if (elements.folderSelectedCount) elements.folderSelectedCount.textContent = `${state.selectedFolderIds.size} seleccionadas`;
    renderFolders();
  }, 450);
}
function cancelFolderLongPress() {
  if (folderLongPressTimer) {
    clearTimeout(folderLongPressTimer);
    folderLongPressTimer = null;
  }
}

function closeShareModal() {
  if (!elements.shareModal) return;
  showOverlay(elements.shareModal, false);
  if (folderSharesUnsubscribe) {
    folderSharesUnsubscribe();
    folderSharesUnsubscribe = null;
  }
  if (shareSearchTimer) {
    clearTimeout(shareSearchTimer);
    shareSearchTimer = null;
  }
  shareContext = null;
}

function renderShareResults() {
  if (!elements.shareResults || !shareContext) return;
  const query = normalizeSearchQuery(elements.shareUserSearch?.value || "");
  const users = Object.entries(state.usersPublic || {});
  const currentShares = shareContext.currentShares || {};
  const filtered = users.filter(([uid, profile]) => {
    if (uid === state.username) return false;
    if (currentShares?.[uid]) return false;
    if (!query) return true;
    const haystack = normalizeSearchQuery(`${profile?.handle || ""} ${profile?.displayName || ""}`);
    return haystack.includes(query);
  });
  elements.shareResults.innerHTML = "";
  if (!query) {
    elements.shareResults.innerHTML = "<div class=\"card\">Empieza a escribir para buscar usuarios.</div>";
    return;
  }
  if (!filtered.length) {
    elements.shareResults.innerHTML = "<div class=\"card\">Sin resultados.</div>";
    return;
  }
  filtered.slice(0, 20).forEach(([uid, profile]) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "list-item";
    item.dataset.shareUid = uid;
    const handle = profile?.handle || uid;
    const displayName = profile?.displayName || handle;
    item.innerHTML = `
      <span class="item-text">
        <span class="item-title">${escapeHtml(displayName)}</span>
        <span class="item-subtitle">@${escapeHtml(handle)}</span>
      </span>
      <span class="item-chevron" aria-hidden="true">›</span>
    `;
    elements.shareResults.appendChild(item);
  });
}

function renderShareCurrentList() {
  if (!elements.shareCurrentList || !shareContext) return;
  const shares = shareContext.currentShares || {};
  const entries = Object.entries(shares);
  elements.shareCurrentList.innerHTML = "";
  if (!entries.length) {
    elements.shareCurrentList.innerHTML = "<div class=\"card\">Aún no compartes esta carpeta.</div>";
    return;
  }
  entries.forEach(([uid, share]) => {
    const profile = state.usersPublic?.[uid] || {};
    const displayName = profile.displayName || profile.handle || uid;
    const handle = profile.handle || uid;
    const roleLabel = share?.role === "editor" ? "Editor" : "Viewer";
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <span class="item-text">
        <span class="item-title">${escapeHtml(displayName)}</span>
        <span class="item-subtitle">@${escapeHtml(handle)} · ${roleLabel}</span>
      </span>
      <div class="item-actions">
        <button class="icon-button icon-button--compact icon-button--danger" type="button" data-unshare-uid="${uid}" aria-label="Quitar">✕</button>
      </div>
    `;
    elements.shareCurrentList.appendChild(item);
  });
}

function openShareModal(folder) {
  if (!elements.shareModal) return;
  shareContext = {
    ownerUid: state.username,
    folderId: folder.id,
    folderName: folder.name,
    currentShares: {},
  };
  if (elements.shareFolderTitle) {
    elements.shareFolderTitle.textContent = `Carpeta: ${folder.name}`;
  }
  if (elements.shareUserSearch) {
    elements.shareUserSearch.value = "";
    elements.shareUserSearch.focus();
  }
  if (elements.shareRoleToggle) {
    elements.shareRoleToggle.checked = false;
  }
  elements.shareResults.innerHTML = "<div class=\"card\">Empieza a escribir para buscar usuarios.</div>";
  elements.shareCurrentList.innerHTML = "<div class=\"card\">Cargando...</div>";
  showOverlay(elements.shareModal, true);
  const db = getDb();
  if (folderSharesUnsubscribe) {
    folderSharesUnsubscribe();
  }
  folderSharesUnsubscribe = listenFolderShares(db, state.username, folder.id, (shares) => {
    if (!shareContext) return;
    shareContext.currentShares = shares || {};
    renderShareCurrentList();
  });
  loadUsersPublic().then(() => renderShareResults());
}

function getAllCardsGroups() {
  const groups = new Map();
  const sortedCards = [...(state.allCards || [])].sort((a, b) => {
    const aFront = String(resolveLegacyOrderCard(a).front || "").toLowerCase();
    const bFront = String(resolveLegacyOrderCard(b).front || "").toLowerCase();
    return aFront.localeCompare(bFront, "es");
  });
  sortedCards.forEach((card) => {
    const folderId = card.folderId || "__unassigned__";
    if (!groups.has(folderId)) groups.set(folderId, []);
    groups.get(folderId).push(card);
  });
  const assigned = [...groups.entries()].filter(([folderId]) => folderId !== "__unassigned__").sort((a, b) => {
    const aName = state.folders[a[0]]?.name || "Carpeta";
    const bName = state.folders[b[0]]?.name || "Carpeta";
    return aName.localeCompare(bName, "es");
  });
  const unassigned = groups.has("__unassigned__") ? [["__unassigned__", groups.get("__unassigned__")]] : [];
  return [...assigned, ...unassigned];
}

function renderAllCardsMoveTargets() {
  if (!elements.allCardsMoveTarget) return;
  const select = elements.allCardsMoveTarget;
  const currentValue = select.value;
  select.innerHTML = '<option value="">Mover a carpeta…</option><option value="__none__">Sin asignar</option>';
  Object.values(state.folders || {})
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"))
    .forEach((folder) => {
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = `${folder.emoji || "📁"} ${folder.name}`;
      select.appendChild(option);
    });
  if (currentValue && select.querySelector(`option[value="${currentValue}"]`)) {
    select.value = currentValue;
  }
}

function updateAllCardsBulkBar(totalCards = 0) {
  const count = state.allCardsSelectedIds.size;
  if (elements.allCardsSelectedCount) {
    elements.allCardsSelectedCount.textContent = `Seleccionadas: ${count}`;
  }
  if (elements.allCardsBulkBar) {
    elements.allCardsBulkBar.classList.toggle("hidden", count === 0);
  }
  if (elements.allCardsMove) elements.allCardsMove.disabled = count === 0;
  if (elements.allCardsDelete) elements.allCardsDelete.disabled = count === 0;
  if (elements.allCardsSelectAll) elements.allCardsSelectAll.disabled = totalCards === 0 || count === totalCards;
  if (elements.allCardsClearAll) elements.allCardsClearAll.disabled = count === 0;
}

function renderAllCardsView() {
  if (!elements.allCardsList) return;
  renderAllCardsMoveTargets();
  const groups = getAllCardsGroups();
  const list = elements.allCardsList;
  list.innerHTML = "";
  if (!groups.length) {
    list.innerHTML = '<div class="card">No hay tarjetas para mostrar.</div>';
    updateAllCardsBulkBar(0);
    return;
  }
  let totalCards = 0;
  const fragment = document.createDocumentFragment();
  groups.forEach(([folderId, cards]) => {
    totalCards += cards.length;
    const isUnassigned = folderId === "__unassigned__";
    const folder = isUnassigned ? null : state.folders[folderId];
    const groupName = isUnassigned ? "Sin asignar" : (folder?.name || "Carpeta eliminada");
    const collapsed = state.allCardsCollapsedGroups.has(folderId);
    const selectedCount = cards.filter((card) => state.allCardsSelectedIds.has(card.id)).length;

    const groupEl = document.createElement("section");
    groupEl.className = "all-cards-group";
    groupEl.dataset.groupId = folderId;
    groupEl.innerHTML = `
      <header class="all-cards-group__header">
        <label class="all-cards-group__check"><input type="checkbox" data-action="toggle-group" data-group-id="${folderId}" ${selectedCount && selectedCount === cards.length ? "checked" : ""} /></label>
        <button class="all-cards-group__toggle" type="button" data-action="toggle-collapse" data-group-id="${folderId}">${collapsed ? "▸" : "▾"}</button>
        <h3>${groupName} (${cards.length})</h3>
      </header>
      <div class="all-cards-group__rows${collapsed ? " hidden" : ""}"></div>
    `;
    const rows = groupEl.querySelector('.all-cards-group__rows');
    cards.forEach((card) => {
      const resolved = resolveLegacyOrderCard(card);
      const row = document.createElement("div");
      row.className = "all-cards-row";
      if (resolved?.cardGrammarType === "noun" && resolved?.nounGender) {
        row.classList.add(`all-cards-row--${resolved.nounGender}`);
      }
      row.dataset.cardId = card.id;
      row.innerHTML = `
        <input type="checkbox" data-action="toggle-card" data-id="${card.id}" ${state.allCardsSelectedIds.has(card.id) ? "checked" : ""} />
        <div class="all-cards-row__text">
          <span class="all-cards-row__front" title="${formatCardText(resolved.front || resolved.clozeText || "(sin frente)")}">${formatCardText(resolved.front || resolved.clozeText || "(sin frente)")}</span>
          <span class="all-cards-row__meta">${resolved.type || "basic"}${(resolved.tags && Object.keys(resolved.tags).length) ? ` · ${Object.keys(resolved.tags).slice(0, 3).join(", ")}` : ""}</span>
        </div>
        <button class="icon-button icon-button--compact" data-action="open" data-id="${card.id}" type="button" aria-label="Ver tarjeta">👁️</button>
      `;
      rows.appendChild(row);
    });
    fragment.appendChild(groupEl);
  });
  list.appendChild(fragment);
  updateAllCardsBulkBar(totalCards);
}

async function handleSaveFolder() {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    return;
  }
  const name = elements.folderNameInput.value.trim();
  const emoji = (elements.folderEmojiInput?.value || "📁").trim() || "📁";
  const color = (elements.folderColorInput?.value || "#8b5cf6").trim() || "#8b5cf6";
  const reviewBothSides = Boolean(elements.folderBothSidesInput?.checked);
  const sourceLang = String(elements.folderSourceLang?.value || "es").trim().toLowerCase();
  const targetLang = String(elements.folderTargetLang?.value || "de").trim().toLowerCase();
  if (!name) {
    showToast("Escribe un nombre.", "error");
    return;
  }
  const db = getDb();
  elements.saveFolder.disabled = true;
  try {
    if (editingFolderId) {
      await updateFolder(db, state.username, editingFolderId, { name, emoji, color, reviewBothSides, sourceLang, targetLang });
    } else {
      await createFolder(db, state.username, { name, emoji, color, reviewBothSides, sourceLang, targetLang, parentId: state.folderBrowseId || null });
    }
    showToast("Guardado");
    closeFolderModal();
  } catch (error) {
    handleErrorToast(error, "Error al guardar carpeta.");
  } finally {
    elements.saveFolder.disabled = false;
  }
}

function updateCardsBulkToolbar() {
  const active = state.cardsSelectionMode;
  const count = state.selectedCardIds.size;
  if (elements.cardsSelectToggle) elements.cardsSelectToggle.textContent = active ? `Cancelar (${count})` : "Seleccionar";
  [elements.cardsBulkMove, elements.cardsBulkClearFolder, elements.cardsBulkDelete].forEach((el) => {
    if (!el) return;
    el.classList.toggle("hidden", !active);
    el.disabled = !count;
  });
}

async function handleCardListAction(event) {
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  const cardId = actionEl.dataset.id;
  if (!action || !cardId) return;
  const card = state.cards.find((item) => item.id === cardId);
  if (!card) return;
  if (isActiveFolderReadOnly()) {
    showToast("Carpeta compartida en solo lectura.", "error");
    return;
  }
  const ownerUid = getActiveOwnerUid();
  if (action === "toggle-select") {
    if (state.selectedCardIds.has(card.id)) state.selectedCardIds.delete(card.id);
    else state.selectedCardIds.add(card.id);
    updateCardsBulkToolbar();
    renderCardsView();
    return;
  }
  if (action === "edit") {
    if (state.cardsSelectionMode) {
      if (state.selectedCardIds.has(card.id)) state.selectedCardIds.delete(card.id);
      else state.selectedCardIds.add(card.id);
      updateCardsBulkToolbar();
      renderCardsView();
      return;
    }
    openCardModal(card);
  }
  if (action === "move") {
    const folderOptions = Object.values(state.folders)
      .map((folder) => `${folder.id}:${folder.name}`)
      .join("\n");
    const newFolderId = prompt(`Mover a carpeta (id:nombre)\n${folderOptions}`);
    if (newFolderId && state.folders[newFolderId]) {
      const db = getDb();
      const selectedGender = wordPopover.dataset.gender || "";
      await moveCardFolder(db, ownerUid, card, newFolderId);
      await loadCards(true);
    }
  }
  if (action === "delete") {
    const confirmDelete = confirm("¿Borrar esta tarjeta?");
    if (confirmDelete) {
      const db = getDb();
      const selectedGender = wordPopover.dataset.gender || "";
      try {
        await deleteCard(db, ownerUid, card);
        showToast("Tarjeta borrada.");
        state.cards = state.cards.filter((item) => item.id !== card.id);
        state.cardsLoadedIds.delete(card.id);
        state.cardCache.delete(card.id);
        state.cardsCache = state.cards;
        renderCardsView();
        await loadStats();
      } catch (error) {
        handleErrorToast(error, "No se pudo borrar la tarjeta.");
      }
    }
  }
}

async function handleSaveCard() {
  const folders = Object.values(state.folders || {});
  const selectedFolderFromModal = elements.cardFolderSelect?.value || "";
  const folderIdForSave = editingCardId
    ? (state.cards.find((card) => card.id === editingCardId)?.folderId || state.selectedFolderId || selectedFolderFromModal || "")
    : (state.cardModalOpenFromFoldersRoot ? selectedFolderFromModal : state.selectedFolderId);
  if (!folderIdForSave && !editingCardId) {
    showToast(folders.length ? "Selecciona una carpeta primero." : "Crea una carpeta antes de añadir tarjetas.", "error");
    return;
  }
  if (isActiveFolderReadOnly()) {
    showToast("Carpeta compartida en solo lectura.", "error");
    return;
  }
  const ownerUid = getActiveOwnerUid();
  const type = elements.cardType.value;
  const front = elements.cardFront.value.trim();
  const back = elements.cardBack.value.trim();
  let conjugations = {};
  let conjugationBlocks = [];
  if (currentGrammarType === "verb") {
    try { conjugations = JSON.parse(elements.cardBack?.dataset?.conjugations || "{}"); } catch {}
    if (!Object.keys(conjugations).length) {
      const parsed = parseGermanConjugationPaste(back);
      if (parsed?.conjugations) conjugations = parsed.conjugations;
      if (parsed?.blocks?.length) conjugationBlocks = parsed.blocks;
    }
    if (!conjugationBlocks.length && Object.keys(conjugations).length) conjugationBlocks = toConjugationBlocksFromMap(conjugations);
  }
  const example = elements.cardExample?.value.trim() || "";
  const clozeText = elements.cardClozeText.value.trim();
  const clozeAnswers = elements.cardClozeAnswers.value
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const orderTokensInput = elements.cardOrderTokens ? elements.cardOrderTokens.value : "";
  const orderLabelsInput = elements.cardOrderLabels ? elements.cardOrderLabels.value : "";
  const orderAnswerInput = elements.cardOrderAnswer ? elements.cardOrderAnswer.value : "";
  if (type === "basic" && (!front || !back)) {
    showToast("Completa frente y reverso.", "error");
    return;
  }
  if (type === "cloze") {
    if (!clozeText || !hasClozeMarker(clozeText)) {
      showToast("El cloze debe incluir ____ en el texto.", "error");
      return;
    }
    if (!clozeAnswers.length) {
      showToast("Añade al menos una respuesta.", "error");
      return;
    }
  }
  let orderTokens = [];
  let orderAnswer = [];
  let orderLabelsCatalog = [];
  let orderTokenLabels = {};
  let legacyOrderLabels = "";
  if (type === "order") {
    if (!front) {
      showToast("Completa FRONT_ES.", "error");
      return;
    }
    if (!back) {
      showToast("Completa TARGET_DE.", "error");
      return;
    }
    const orderTokensResult = buildOrderTokens(orderTokensInput, orderLabelsInput, orderEditorState);
    if (orderTokensResult.errors.length) {
      showToast(orderTokensResult.errors.join(" "), "error");
      return;
    }
    orderTokens = orderTokensResult.tokens;
    orderAnswer = orderTokens.map((token) => token.id);
    orderLabelsCatalog = orderTokensResult.labelsCatalog;
    orderTokenLabels = orderTokensResult.tokenLabels;
    legacyOrderLabels = elements.cardOrderLabels ? elements.cardOrderLabels.value : "";
  }
  const tags = normalizeTags(elements.cardTags.value);
  const selectedTags = dedupeTags([...state.selectedTags]);
  const finalTags = dedupeTags([...selectedTags, ...tags]);
  const db = getDb();
  if (editingCardId) {
    try {
      const result = await updateCard(db, ownerUid, editingCardId, {
        type,
        front,
        back,
        example,
        clozeText,
        clozeAnswers,
        orderTokens,
        orderAnswer,
        orderLabelsCatalog,
        orderTokenLabels,
        labels: legacyOrderLabels,
        tags: tagsToMap(finalTags),
        cardGrammarType: currentGrammarType,
        nounGender: currentGrammarType === "noun" ? (cardNounGender || null) : null,
        conjugationBlocks,
        conjugations,
      });
      if (result?.status === "duplicate") {
        showToast("Duplicado omitido.");
        return;
      }
      showToast("Guardado");
    } catch (error) {
      handleErrorToast(error, "Error al guardar tarjeta.");
      return;
    }
  } else {
    const id = `card_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
    try {
      const result = await upsertCardWithDedupe(db, ownerUid, {
        id,
        folderId: folderIdForSave,
        type,
        front,
        back,
        example,
        clozeText,
        clozeAnswers,
        orderTokens,
        orderAnswer,
        orderLabelsCatalog,
        orderTokenLabels,
        labels: legacyOrderLabels,
        tags: tagsToMap(finalTags),
        cardGrammarType: currentGrammarType,
        nounGender: currentGrammarType === "noun" ? (cardNounGender || null) : null,
        conjugationBlocks,
        conjugations,
      });
      if (result.status === "duplicate") {
        showToast("Duplicado omitido.");
        return;
      } else if (result.status === "updated") {
        showToast("Tarjeta actualizada.");
        return;
      } else {
        showToast("Tarjeta guardada");
      }
    } catch (error) {
      handleErrorToast(error, "Error al crear tarjeta.");
      return;
    }
    elements.cardFront.value = "";
    elements.cardBack.value = "";
    if (elements.cardExample) elements.cardExample.value = "";
    autoResizeTextarea(elements.cardFront);
    autoResizeTextarea(elements.cardBack);
    elements.cardClozeText.value = "";
    elements.cardClozeAnswers.value = "";
    if (elements.cardOrderTokens) {
      elements.cardOrderTokens.value = "";
    }
    if (elements.cardOrderLabels) {
      elements.cardOrderLabels.value = "";
    }
    if (elements.cardOrderAnswer) {
      elements.cardOrderAnswer.value = "";
    }
    cardFrontManuallyEdited = false;
    cardBackManuallyEdited = false;
    cardLastTranslation = "";
    if (cardTranslateAbortController) cardTranslateAbortController.abort();
    cardTranslateAbortController = null;
    setTranslateStatus("");
    elements.cardTranslateEsDe?.classList.add("hidden");
    elements.cardTranslateDeEs?.classList.add("hidden");
    elements.cardTranslateContextField?.classList.add("hidden");
    if (elements.cardTranslateContext) {
      elements.cardTranslateContext.value = "";
    }
    refreshTranslateCta();
    hydrateOrderEditorState(null);
    elements.cardTags.value = "";
    state.selectedTags = new Set();
    renderTagPanels();
    if (currentGrammarType === "verb" && !String(elements.cardBack.value || "").trim()) {
      elements.cardBack.value = VERB_TEMPLATE;
      autoResizeTextarea(elements.cardBack);
      console.info("[grammar:apply-template]", { source: "after-save", next: currentGrammarType });
    }
    if (currentGrammarType === "noun") {
      cardNounGender = null;
      syncGrammarControls();
    }
    elements.cardFront.focus();
    if (state.cardModalOpenFromFoldersRoot) {
      state.cardModalLastSelectedFolderId = folderIdForSave;
      renderCardFolderSelector({
        openedFromFoldersRoot: true,
        selectedFolderId: state.cardModalLastSelectedFolderId,
      });
    }
    await loadCards(true);
    return;
  }
  closeCardModal();
  await loadCards(true);
}

function isClozeCorrect(card, answer) {
  const normalized = answer.trim();
  if (!normalized) return false;
  const answers = card.clozeAnswers || [];
  return answers.some((entry) => {
    if (state.prefs.clozeCaseInsensitive) {
      return entry.trim().toLowerCase() === normalized.toLowerCase();
    }
    return entry.trim() === normalized;
  });
}

function hasClozeMarker(text) {
  return /_{4,}/.test(text);
}

function tokenizeClozeText(text) {
  const tokens = [];
  const regex = /_{4,}/g;
  let lastIndex = 0;
  let match = regex.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    tokens.push({ type: "blank" });
    lastIndex = match.index + match[0].length;
    match = regex.exec(text);
  }
  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}

function normalizeClozeEntry(entry) {
  const trimmed = entry.trim();
  return state.prefs.clozeCaseInsensitive ? trimmed.toLowerCase() : trimmed;
}

function evaluateClozeAnswers(card, userAnswers, blankCount) {
  if (blankCount <= 1) {
    const correct = isClozeCorrect(card, userAnswers[0] || "");
    return { correct, results: [correct] };
  }
  const expected = card.clozeAnswers || [];
  const results = Array.from({ length: blankCount }, (_, index) => {
    const expectedEntry = expected[index];
    if (!expectedEntry) return false;
    const userEntry = userAnswers[index] || "";
    if (!userEntry.trim()) return false;
    return normalizeClozeEntry(expectedEntry) === normalizeClozeEntry(userEntry);
  });
  return { correct: results.every(Boolean), results };
}

function ensureOrderState(card) {
  if (state.reviewOrder?.cardId === card.id) return state.reviewOrder;
  state.reviewOrder = buildOrderState(card);
  return state.reviewOrder;
}

function renderReviewCard(card, showBack = false) {
  elements.reviewCard.innerHTML = "";
  const resolvedCard = resolveLegacyOrderCard(card);
  const { sourceLang, targetLang } = getActiveFolderLanguages();
  elements.reviewCard.classList.remove("review-card--der", "review-card--die", "review-card--das");
  if (resolvedCard?.cardGrammarType === "noun" && resolvedCard?.nounGender) {
    elements.reviewCard.classList.add(`review-card--${resolvedCard.nounGender}`);
  }
  const wrapper = document.createElement("div");
  wrapper.className = showBack ? "review-text review-text--reveal" : "review-text";
  const glossaryMap = buildGlossaryMap(resolvedCard);

  if (resolvedCard.type === "cloze") {
    const promptSection = document.createElement("div");
    promptSection.className = "review-section";
    const promptLabel = document.createElement("span");
    promptLabel.className = "review-label";
    promptLabel.textContent = "Español";
    const promptText = document.createElement("div");
    promptText.className = "review-back";
    const promptValue = (resolvedCard.front || "").trim();
    promptText.textContent = promptValue || "Traduce al alemán:";
    promptSection.appendChild(promptLabel);
    promptSection.appendChild(promptText);
    wrapper.appendChild(promptSection);

    const frontSection = document.createElement("div");
    frontSection.className = "review-section";
    const frontLabel = document.createElement("span");
    frontLabel.className = "review-label";
    frontLabel.textContent = "Alemán (completa huecos)";
    const frontText = document.createElement("div");
    const clozeTokens = tokenizeClozeText(resolvedCard.clozeText || "");
    const blankCount = clozeTokens.filter((token) => token.type === "blank").length;
    frontText.className = blankCount ? "review-front review-front--cloze" : "review-front";
    const answers = blankCount
      ? state.reviewClozeAnswers.length === blankCount
        ? [...state.reviewClozeAnswers]
        : Array.from({ length: blankCount }, () => "")
      : [state.reviewClozeAnswers[0] || ""];
    state.reviewClozeAnswers = answers;
    const inlineInputs = [];
    const evaluation = showBack ? evaluateClozeAnswers(resolvedCard, answers, blankCount) : null;
    const updateInlineSize = (input) => {
      const nextSize = Math.min(Math.max(input.value.length, 4), 16);
      input.size = nextSize;
    };
    if (blankCount) {
      let blankIndex = 0;
      clozeTokens.forEach((token) => {
        if (token.type === "text") {
          frontText.appendChild(renderTextWithLanguage(token.value, "de", glossaryMap));
          return;
        }
        const currentIndex = blankIndex;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "cloze-input cloze-input--inline";
        input.value = answers[currentIndex] || "";
        input.disabled = showBack;
        input.autocomplete = "off";
        input.autocapitalize = "none";
        input.spellcheck = false;
        input.inputMode = "text";
        input.setAttribute("aria-label", `Hueco ${currentIndex + 1}`);
        updateInlineSize(input);
        input.addEventListener("input", () => {
          state.reviewClozeAnswers[currentIndex] = input.value;
          updateInlineSize(input);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const nextInput = inlineInputs[currentIndex + 1];
          if (nextInput) {
            nextInput.focus();
            return;
          }
          if (!showBack) {
            elements.flipCard.click();
          }
        });
        if (showBack && evaluation) {
          input.classList.add(
            evaluation.results[currentIndex] ? "cloze-input--correct" : "cloze-input--incorrect"
          );
        }
        inlineInputs.push(input);
        frontText.appendChild(input);
        blankIndex += 1;
      });
    } else {
      frontText.appendChild(renderTextWithLanguage(resolvedCard.clozeText || "", "de", glossaryMap));
    }
    frontSection.appendChild(frontLabel);
    frontSection.appendChild(frontText);
    frontSection.appendChild(buildAudioButton((resolvedCard.front || ""), targetLang));
    wrapper.appendChild(frontSection);

    if (showBack) {
      const backSection = document.createElement("div");
      backSection.className = "review-section";
      const backLabel = document.createElement("span");
      backLabel.className = "review-label";
      backLabel.textContent = "Respuesta";
      const answers = document.createElement("div");
      answers.className = "review-back";
      answers.textContent = formatCardText((resolvedCard.clozeAnswers || []).join(" | ")) || "-";
      backSection.appendChild(backLabel);
      backSection.appendChild(answers);
      wrapper.appendChild(backSection);

      const correct = blankCount
        ? evaluation?.correct
        : isClozeCorrect(resolvedCard, answers[0] || "");
      const feedback = document.createElement("div");
      feedback.className = "review-feedback";
      feedback.textContent = correct ? "Respuesta correcta." : "Respuesta incorrecta.";
      wrapper.appendChild(feedback);
    }
  } else if (resolvedCard.type === "order") {
    const orderState = ensureOrderState(resolvedCard);
    const evaluation = showBack ? evaluateOrderState(orderState) : null;
    const frontSection = document.createElement("div");
    frontSection.className = "review-section";
    const frontLabel = document.createElement("span");
    frontLabel.className = "review-label";
    frontLabel.textContent = "Español";
    const frontText = document.createElement("div");
    frontText.className = "review-front";
    frontText.appendChild(renderTextWithLanguage(resolvedCard.front || "", "es", glossaryMap));
    frontSection.appendChild(frontLabel);
    frontSection.appendChild(frontText);
    frontSection.appendChild(buildAudioButton((resolvedCard.front || ""), sourceLang));
    wrapper.appendChild(frontSection);

    const orderCard = document.createElement("div");
    orderCard.className = `order-card${showBack ? " order-card--locked" : ""}`;
    const answerSection = document.createElement("div");
    answerSection.className = "order-zone";
    const answerLabel = document.createElement("div");
    answerLabel.className = "order-zone__label";
    answerLabel.textContent = "Respuesta";
    const answerRow = document.createElement("div");
    answerRow.className = "order-chip-row order-chip-row--answer";
    answerSection.appendChild(answerLabel);
    answerSection.appendChild(answerRow);
    const bankSection = document.createElement("div");
    bankSection.className = "order-zone order-bank";
    const bankLabel = document.createElement("div");
    bankLabel.className = "order-zone__label";
    bankLabel.textContent = "Banco de palabras";
    const bankRow = document.createElement("div");
    bankRow.className = "order-chip-row order-chip-row--bank";
    bankSection.appendChild(bankLabel);
    bankSection.appendChild(bankRow);

    orderCard.appendChild(answerSection);
    orderCard.appendChild(bankSection);

    let dragInProgress = false;

    const controls = document.createElement("div");
    controls.className = "order-controls";
    const resetButton = document.createElement("button");
    resetButton.className = "button ghost small";
    resetButton.type = "button";
    resetButton.textContent = "Reiniciar";
    resetButton.disabled = showBack;
    resetButton.addEventListener("click", () => {
      resetOrderState(orderState);
      renderReviewCard(resolvedCard, false);
    });
    controls.appendChild(resetButton);
    orderCard.appendChild(controls);

    const buildChip = (token, zone, index, evaluationResult = null) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "order-chip";
      chip.dataset.id = token.id;
      chip.dataset.zone = zone;
      chip.dataset.index = String(index);
      chip.innerHTML = `
        <span class="order-chip__text"></span>
        <span class="order-chip__label"></span>
      `;
      chip.querySelector(".order-chip__text").textContent = token.text;
      const label = chip.querySelector(".order-chip__label");
      label.textContent = token.label;
      if (!token.label) {
        chip.classList.add("order-chip--no-label");
      }
      if (showBack && typeof evaluationResult === "boolean") {
        chip.classList.add(evaluationResult ? "order-chip--correct" : "order-chip--incorrect");
      }
      return chip;
    };

    const renderAnswer = () => {
      answerRow.innerHTML = "";
      orderState.selected.forEach((tokenId, index) => {
        const token = orderState.tokenMap[tokenId];
        if (!token) return;
        const evaluationResult = showBack && evaluation ? evaluation.results[index] : null;
        const chip = buildChip(token, "answer", index, evaluationResult);
        answerRow.appendChild(chip);
      });
    };

    const renderBank = () => {
      bankRow.innerHTML = "";
      orderState.bank.forEach((tokenId, index) => {
        const token = orderState.tokenMap[tokenId];
        const chip = buildChip(token, "bank", index);
        bankRow.appendChild(chip);
      });
    };

    const renderOrderLayout = () => {
      renderAnswer();
      renderBank();
    };

    const syncOrderStateFromDom = () => {
      orderState.selected = Array.from(answerRow.querySelectorAll(".order-chip")).map(
        (chip) => chip.dataset.id
      );
      orderState.bank = Array.from(bankRow.querySelectorAll(".order-chip")).map(
        (chip) => chip.dataset.id
      );
    };

    const handleChipClick = (event) => {
      if (showBack) return;
      if (dragInProgress) return;
      const chip = event.target.closest(".order-chip");
      if (!chip) return;
      const tokenId = chip.dataset.id;
      const zone = chip.dataset.zone;
      if (zone === "bank") {
        moveOrderToken(orderState, tokenId, "selected");
      } else {
        moveOrderToken(orderState, tokenId, "bank");
      }
      renderOrderLayout();
    };

    orderCard.addEventListener("click", handleChipClick);

    renderOrderLayout();

    if (!showBack && window.Sortable) {
      const sharedOptions = {
        group: { name: "orderTokens", pull: true, put: true },
        animation: 150,
        ghostClass: "order-chip--ghost",
        chosenClass: "order-chip--chosen",
        dragClass: "order-chip--dragging",
        fallbackOnBody: true,
        forceFallback: true,
        swapThreshold: 0.65,
        touchStartThreshold: 5,
        onStart: () => {
          dragInProgress = true;
        },
        onEnd: () => {
          dragInProgress = false;
          syncOrderStateFromDom();
          renderOrderLayout();
        },
      };
      window.Sortable.create(answerRow, {
        ...sharedOptions,
        sort: true,
        onUpdate: (event) => {
          moveSelected(orderState, event.oldIndex ?? 0, event.newIndex ?? 0);
          renderOrderLayout();
        },
        onAdd: (event) => {
          const tokenId = event.item?.dataset?.id;
          insertFromAvailable(orderState, tokenId, event.newIndex ?? orderState.selected.length);
          renderOrderLayout();
        },
      });
      window.Sortable.create(bankRow, {
        ...sharedOptions,
        sort: false,
      });
    }

    const answerLinesRaw = Number(state.prefs.orderAnswerLines || 2);
    const answerLines = Math.min(3, Math.max(2, answerLinesRaw));
    orderCard.style.setProperty("--order-answer-lines", String(answerLines));
    wrapper.appendChild(orderCard);

    if (showBack && evaluation && shouldShowOrderSolution(evaluation)) {
      const solution = document.createElement("div");
      solution.className = "order-solution";
      const solutionLabel = document.createElement("div");
      solutionLabel.className = "order-solution__label";
      solutionLabel.textContent = "Respuesta correcta";
      const solutionRow = document.createElement("div");
      solutionRow.className = "order-chip-row order-chip-row--solution";
      const solutionText = document.createElement("div");
      solutionText.className = "order-solution__text";
      const solutionTokens = buildOrderSolution(orderState, evaluation);
      solutionTokens.forEach(({ token, isCorrectPosition }, index) => {
        if (!token) return;
        const chip = buildChip(token, "solution", index);
        if (typeof isCorrectPosition === "boolean") {
          chip.classList.add(isCorrectPosition ? "order-chip--correct" : "order-chip--incorrect");
        }
        solutionRow.appendChild(chip);
      });
      solutionText.textContent = solutionTokens
        .map(({ token }) => token?.text)
        .filter(Boolean)
        .join(" ");
      solution.appendChild(solutionLabel);
      solution.appendChild(solutionRow);
      solution.appendChild(solutionText);
      wrapper.appendChild(solution);
    }

    if (showBack && evaluation) {
      const feedback = document.createElement("div");
      feedback.className = `review-feedback ${evaluation.correct ? "is-correct" : "is-incorrect"}`;
      feedback.textContent = evaluation.filled
        ? evaluation.correct
          ? "Orden correcto."
          : "Orden incorrecto."
        : "Orden incompleto.";
      wrapper.appendChild(feedback);
    }
  } else {
    const frontSection = document.createElement("div");
    frontSection.className = "review-section";
    const frontLabel = document.createElement("span");
    frontLabel.className = "review-label";
    frontLabel.textContent = "Frente";
    const frontText = document.createElement("div");
    frontText.className = "review-front";
    frontText.appendChild(renderTextWithLanguage(resolvedCard.front || "", "de", glossaryMap));
    injectInlineSpeechButtons(frontText, sourceLang);
    frontSection.appendChild(frontLabel);
    frontSection.appendChild(frontText);
    frontSection.appendChild(buildAudioButton((resolvedCard.front || ""), sourceLang));
    wrapper.appendChild(frontSection);

    if (showBack) {
      const backSection = document.createElement("div");
      backSection.className = "review-section";
      const backLabel = document.createElement("span");
      backLabel.className = "review-label";
      backLabel.textContent = "Reverso";
      const backText = document.createElement("div");
      backText.className = "review-back";
      const normalizedVerbCard = ensureCardConjugationStructure(resolvedCard);
      const blocks = getCardConjugationBlocks(normalizedVerbCard);
      if (resolvedCard.cardGrammarType === "verb" && blocks.length) {
        const kpi = document.createElement("div");
        kpi.className = "review-conj-tabs";
        const active = reviewConjugationHeading && blocks.some((b) => b.heading === reviewConjugationHeading)
          ? reviewConjugationHeading
          : blocks[0].heading;
        reviewConjugationHeading = active;
        blocks.forEach((block) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `chip-toggle${block.heading === active ? " active is-active" : ""}`;
          btn.textContent = block.label || block.heading;
          btn.addEventListener("click", () => {
            reviewConjugationHeading = block.heading;
            refreshCurrentReviewCard();
          });
          kpi.appendChild(btn);
        });
        backSection.appendChild(kpi);
        const selected = blocks.find((b) => b.heading === active) || blocks[0];
        const lines = ["ich", "du", "er/sie/es", "wir", "ihr", "sie"].map((p) => {
          const lbl = p === "er/sie/es" ? "er / sie / es" : (p === "sie" ? "sie / Sie" : p);
          return `${lbl} - ${selected.forms?.[p] || "-"}`;
        }).join("\n");
        backText.appendChild(renderBackWithLanguage(lines, glossaryMap));
      } else {
        backText.appendChild(renderBackWithLanguage(resolvedCard.back || "", glossaryMap));
      }
      injectInlineSpeechButtons(backText, targetLang);
      backSection.appendChild(backLabel);
      backSection.appendChild(backText);
      backSection.appendChild(buildAudioButton((resolvedCard.back || ""), targetLang));
      if (resolvedCard.example) {
        const exampleText = document.createElement("div");
        exampleText.className = "review-example";
        exampleText.appendChild(renderTextWithLanguage(resolvedCard.example, targetLang, glossaryMap));
        backSection.appendChild(exampleText);
      }
      wrapper.appendChild(backSection);
    }
  }

  elements.reviewCard.appendChild(wrapper);
}

function ensureSwipeOverlay() {
  let overlay = elements.reviewCard.querySelector(".review-swipe-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "review-swipe-overlay";
    const label = document.createElement("div");
    label.className = "review-swipe-label";
    overlay.appendChild(label);
    elements.reviewCard.appendChild(overlay);
  }
  return overlay;
}

function updateSwipeOverlay(action, intensity) {
  const overlay = ensureSwipeOverlay();
  const label = overlay.querySelector(".review-swipe-label");
  if (!action || intensity <= 0) {
    overlay.style.opacity = "0";
    overlay.style.background = "transparent";
    label.textContent = "";
    return;
  }
  const capped = Math.min(0.8, intensity);
  let color = "transparent";
  let text = "";
  switch (action) {
    case "error":
      color = `rgba(251, 113, 133, ${capped})`;
      text = "ERROR";
      break;
    case "easy":
      color = `rgba(52, 211, 153, ${capped})`;
      text = "FÁCIL";
      break;
    case "good":
      color = `rgba(59, 130, 246, ${capped})`;
      text = "BUENO";
      break;
    case "bad":
      color = `rgba(251, 191, 36, ${capped})`;
      text = "MALO";
      break;
    default:
      break;
  }
  overlay.style.opacity = "1";
  overlay.style.background = color;
  label.textContent = text;
}

function resetSwipeVisuals({ animate = true } = {}) {
  if (!elements.reviewCard) return;
  elements.reviewCard.style.transition = animate ? "transform 0.25s ease-out" : "none";
  elements.reviewCard.style.transform = "translate(0px, 0px) rotate(0deg)";
  updateSwipeOverlay(null, 0);
}

function applySwipeVisuals(dx, dy) {
  const maxRotation = 6;
  const rotation = Math.max(-maxRotation, Math.min(maxRotation, dx / 20));
  elements.reviewCard.style.transition = "none";
  elements.reviewCard.style.transform = `translate(${dx}px, ${dy}px) rotate(${rotation}deg)`;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const intensity = Math.min(1, Math.max(absX, absY) / 180);
  let action = null;
  if (absX > absY) {
    action = dx > 0 ? "easy" : "error";
  } else {
    action = dy < 0 ? "good" : "bad";
  }
  updateSwipeOverlay(action, intensity);
}

function resolveSwipeAction(dx, dy) {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const threshold = 110;
  if (absX < threshold && absY < threshold) return null;
  if (absX >= absY) {
    if (absX < absY * 1.25) return null;
    return dx > 0 ? "easy" : "error";
  }
  if (absY < absX * 1.25) return null;
  return dy < 0 ? "good" : "bad";
}

async function buildReviewQueue() {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    state.reviewQueue = [];
    state.currentSessionQueue = [];
    state.currentIndex = 0;
    return;
  }
  const selections = getReviewFolderSelections();
  const primarySelection = selections.length === 1 ? selections[0] : null;
  state.reviewFolderOwnerUid = primarySelection?.ownerUid || null;
  state.reviewFolderRole = primarySelection?.role || null;
  state.reviewFolderIsShared = Boolean(primarySelection?.isShared);
  const { includeTags, excludeTags } = getReviewTagFilters();
  const selectedBuckets = Object.entries(state.reviewBuckets)
    .filter(([, active]) => active)
    .map(([bucket]) => canonicalizeBucketId(bucket))
    .filter(Boolean);
  const normalizedState = {
    ...state,
    reviewIncludeTags: includeTags,
    reviewExcludeTagsList: excludeTags,
    selectedBuckets,
  };
  const maxNew = Number(elements.reviewMaxNew.value || state.prefs.maxNew);
  const maxReviews = Number(elements.reviewMax.value || state.prefs.maxReviews);
  const loadedCards = await loadReviewCards(state);
  const { candidates, debug } = getReviewCandidates(normalizedState, loadedCards, state.folders || {});
  console.log("[review-debug:start]", debug);

  const newCards = shuffle(candidates.filter((card) => (canonicalizeBucketId(card.srs?.bucket) || "new") === "new")).slice(0, maxNew);
  const reviewCards = shuffle(candidates.filter((card) => (canonicalizeBucketId(card.srs?.bucket) || "new") !== "new")).slice(0, maxReviews);
  const limited = shuffle([...newCards, ...reviewCards]);
  const shouldRandomBothSides = Boolean(primarySelection && !primarySelection.isShared && state.folders?.[primarySelection.folderId]?.reviewBothSides);
  if (shouldRandomBothSides) {
    limited.forEach((card) => { card.__reversePrompt = Math.random() < 0.5; });
  }

  state.reviewLastEmptyReason = "";
  if (!limited.length) {
    const explain = (debug.reductions || [])
      .map((step) => `${step.filter} (${step.before}->${step.after})`)
      .join(", ");
    state.reviewLastEmptyReason = `0 tarjetas: ${explain}`;
  }
  state.reviewQueue = limited;
  state.currentSessionQueue = limited.map((card) => card.id);
  state.currentIndex = 0;
}

function showNextReviewCard() {
  const total = state.sessionTotal || state.reviewQueue.length;
  const card = state.reviewQueue[state.currentIndex];
  if (!card) {
    if (state.sessionActive && state.currentIndex >= state.sessionTotal && state.sessionTotal > 0) {
      elements.reviewActions.classList.add("hidden");
      elements.flipCard.classList.add("hidden");
      elements.reviewCard.classList.add("hidden");
      if (elements.reviewEditCard) {
        elements.reviewEditCard.disabled = true;
      }
      if (elements.reviewPlayerCounter) {
        const totalCount = state.sessionTotal || state.reviewQueue.length;
        elements.reviewPlayerCounter.textContent = `${totalCount}/${totalCount}`;
      }
      if (!state.sessionEnding) {
        state.sessionEnding = true;
        showToast("Sesión terminada");
        setTimeout(() => {
          exitReviewPlayer();
          state.sessionEnding = false;
        }, 800);
      }
    }
    return;
  }
  elements.reviewCard.classList.remove("hidden");
  elements.reviewActions.classList.add("hidden");
  elements.flipCard.classList.remove("hidden");
  state.reviewClozeAnswers = [];
  state.reviewOrder = null;
  state.reviewShowingBack = false;
  const resolvedCard = resolveLegacyOrderCard(card);
  if (resolvedCard.type === "basic" && card?.__reversePrompt) {
    const swapped = { ...resolvedCard, front: resolvedCard.back, back: resolvedCard.front };
    state.reviewCurrentRenderedCard = swapped;
    elements.flipCard.textContent = "Mostrar respuesta";
    renderReviewCard(swapped, false);
  } else {
    state.reviewCurrentRenderedCard = resolvedCard;
    elements.flipCard.textContent = resolvedCard.type === "cloze" || resolvedCard.type === "order"
    ? "Comprobar"
    : "Mostrar respuesta";
  renderReviewCard(state.reviewCurrentRenderedCard || resolvedCard, false);
  }
  resetSwipeVisuals({ animate: false });
  updateReviewAccessUI(card);
  updateReviewRatingButtons(card);
  if (elements.reviewPlayerCounter) {
    elements.reviewPlayerCounter.textContent = `${state.currentIndex + 1}/${total}`;
  }
  if (elements.reviewPlayerBucket) {
    const bucketLabel = BUCKET_LABELS[card.srs?.bucket] || "";
    elements.reviewPlayerBucket.textContent = bucketLabel;
    elements.reviewPlayerBucket.classList.toggle("hidden", !bucketLabel);
  }
}

async function loadMoreCardsPage() {
  const activeRef = getActiveFolderRef();
  if (!activeRef?.folderId) return;
  if (state.cardsLoadMode !== "paged") {
    state.cardsHasMore = false;
    return;
  }
  const db = getDb();
  const cursor = state.cardsPageCursor;
  console.log("LOADMORE start", cursor);
  const result = await fetchCardsByFolder(
    db,
    activeRef.ownerUid,
    activeRef.folderId,
    20,
    cursor
  );
  const newCards = result.cards.filter((card) => !state.cardsLoadedIds.has(card.id));
  newCards.forEach((card) => state.cardsLoadedIds.add(card.id));
  state.cards = [...state.cards, ...newCards];
  state.cardsCache = state.cards;
  state.cardsPageCursor = result.cursor;
  state.cardsHasMore = result.hasMore;
  console.log("LOADMORE got", newCards.length);
  return newCards.length;
}

function revealReviewAnswer() {
  const card = state.reviewQueue[state.currentIndex];
  if (!card) return;
  const inputs = elements.reviewCard.querySelectorAll(".cloze-input");
  if (inputs.length) {
    state.reviewClozeAnswers = Array.from(inputs, (input) => input.value);
  }
  const resolvedCard = state.reviewCurrentRenderedCard || resolveLegacyOrderCard(card);
  renderReviewCard(resolvedCard, true);
  state.reviewShowingBack = true;
  elements.reviewActions.classList.remove("hidden");
  elements.flipCard.classList.add("hidden");
  updateReviewAccessUI(card);
  updateReviewRatingButtons(card);
}

function exitReviewPlayer() {
  setReviewMode(false);
  state.reviewQueue = [];
  state.currentSessionQueue = [];
  state.currentIndex = 0;
  state.sessionActive = false;
  state.sessionTotal = 0;
  state.reviewShowingBack = false;
  state.reviewOrder = null;
  state.sessionEnding = false;
  state.reviewFolderOwnerUid = null;
  state.reviewFolderRole = null;
  state.reviewFolderIsShared = false;
  if (elements.reviewCard) {
    elements.reviewCard.classList.remove("hidden");
  }
  if (elements.reviewEditCard) {
    elements.reviewEditCard.disabled = true;
  }
}

async function handleReviewRating(rating) {
  const card = state.reviewQueue[state.currentIndex];
  if (!card) return;
  const context = getReviewCardContext(card);
  const readOnly = context.isShared && context.role !== "editor";
  if (readOnly) {
    showToast("Solo lectura: el progreso no se guarda.", "error");
    state.sessionStats.answeredCount += 1;
    state.currentIndex += 1;
    showNextReviewCard();
    return;
  }
  if (rating === "easy" && !isEasyAllowed(card)) {
    rating = "good";
  }
  const db = getDb();
  const nextSrs = computeNextSrs(card.srs, rating);
  const ownerUid = context.ownerUid || state.username;
  try {
    await updateReview(db, ownerUid, card, nextSrs);
    card.srs = nextSrs;
    state.cardCache.set(card.id, card);

    const now = Date.now();
    const minutesDelta = state.lastReviewAt ? Math.max(0, Math.round((now - state.lastReviewAt) / 60000)) : 0;
    state.lastReviewAt = now;
    const tags = mapToTags(card.tags);
    await recordReviewStats(db, userRoot(ownerUid), {
      rating,
      folderId: card.folderId,
      tags,
      minutes: minutesDelta,
      isNew: (card.srs.repetitions ?? card.srs.reps ?? 0) <= 1,
    });
  } catch (error) {
    handleErrorToast(error, "No se pudo guardar el repaso.");
    return;
  }

  if (rating === "error") {
    const reinjectedCard = {
      ...card,
      srs: { ...nextSrs },
    };
    state.reviewQueue.splice(state.currentIndex + 1, 0, reinjectedCard);
    state.sessionTotal += 1;
  }

  state.sessionStats.answeredCount += 1;
  state.currentIndex += 1;
  showNextReviewCard();
  await loadStats();
}

function handleReviewPointerDown(event) {
  if (!elements.reviewCard || !state.reviewShowingBack) return;
  if (elements.screenReviewPlayer?.classList.contains("hidden")) return;
  if (event.button && event.button !== 0) return;
  if (wordPopover && !wordPopover.classList.contains("hidden")) return;
  if (event.target.closest(".word")) return;
  swipeState.active = true;
  swipeState.pointerId = event.pointerId;
  swipeState.startX = event.clientX;
  swipeState.startY = event.clientY;
  swipeState.currentX = event.clientX;
  swipeState.currentY = event.clientY;
  swipeState.action = null;
  elements.reviewCard.setPointerCapture(event.pointerId);
  elements.reviewCard.classList.add("review-card--dragging");
}

function handleReviewPointerMove(event) {
  if (!swipeState.active || swipeState.pointerId !== event.pointerId) return;
  const dx = event.clientX - swipeState.startX;
  const dy = event.clientY - swipeState.startY;
  swipeState.currentX = event.clientX;
  swipeState.currentY = event.clientY;
  applySwipeVisuals(dx, dy);
}

function finalizeSwipe(event) {
  if (!swipeState.active || swipeState.pointerId !== event.pointerId) return;
  const dx = swipeState.currentX - swipeState.startX;
  const dy = swipeState.currentY - swipeState.startY;
  swipeState.active = false;
  swipeState.pointerId = null;
  elements.reviewCard.classList.remove("review-card--dragging");
  const action = resolveSwipeAction(dx, dy);
  if (!action) {
    resetSwipeVisuals({ animate: true });
    return;
  }
  swipeState.action = action;
  const outX = dx === 0 ? (action === "easy" ? 260 : -260) : dx * 1.4;
  const outY = dy === 0 ? (action === "good" ? -260 : 260) : dy * 1.4;
  const maxRotation = 6;
  const rotation = Math.max(-maxRotation, Math.min(maxRotation, outX / 20));
  elements.reviewCard.style.transition = "transform 0.28s ease-out";
  elements.reviewCard.style.transform = `translate(${outX}px, ${outY}px) rotate(${rotation}deg)`;
  updateSwipeOverlay(action, 0.8);
  elements.reviewCard.addEventListener(
    "transitionend",
    () => {
      resetSwipeVisuals({ animate: false });
      handleReviewRating(action);
    },
    { once: true }
  );
}

async function handleImportPreview() {
  const parsed = parseChankiImport(elements.importText.value);
  const { text, cardCount } = buildImportPreview(parsed, {
    mode: importState.mode,
    folderFallback: "Importadas",
  });
  if (!cardCount) {
    elements.importPreview.textContent =
      "No se encontraron tarjetas. Usa TYPE: con FRONT/BACK o líneas \"front :: back\".";
    elements.importPreview.classList.add("error");
  } else {
    elements.importPreview.textContent = text;
    elements.importPreview.classList.remove("error");
  }
  elements.importPreview.dataset.parsed = JSON.stringify(parsed);
}

async function importBlocks(blocks, options = {}) {
  const db = getDb();
  const activeRef = getActiveFolderRef();
  const ownerUid = activeRef?.ownerUid || state.username;
  const folderFallback = options.folderFallback || "Importadas";
  const summary = { created: 0, updated: 0, duplicates: 0, createdFolders: 0, processedCards: 0 };
  const resolvedFolders = new Map();
  for (const block of blocks) {
    const folderPath = options.forcedFolderId || options.forceNoFolder ? null : resolveBlockFolderPath(block, folderFallback);
    let folderId = options.forcedFolderId || null;
    if (options.forceNoFolder) {
      folderId = null;
    } else if (!folderId) {
      if (activeRef?.isShared) throw new Error("No puedes crear carpetas en una compartida.");
      const normalizedPath = normalizeFolderPath(folderPath);
      if (resolvedFolders.has(normalizedPath)) {
        folderId = resolvedFolders.get(normalizedPath);
      } else {
        const existingId = findFolderIdByImportPath(normalizedPath);
        folderId = await ensureFolderIdForImportPath(db, ownerUid, normalizedPath, state.folders);
        resolvedFolders.set(normalizedPath, folderId);
        if (!existingId) summary.createdFolders += 1;
      }
    }
    const cardsToImport = block.cards.map((card) => ({
      id: `card_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
      folderId,
      type: card.type || "basic",
      front: card.front,
      back: card.back,
      clozeText: card.clozeText,
      clozeAnswers: card.clozeAnswers || [],
      orderTokens: card.orderTokens || [],
      orderAnswer: card.orderAnswer || [],
      tags: tagsToMap(card.tags || block.tags || []),
    }));
    const result = await importCards(db, ownerUid, cardsToImport, folderId);
    summary.created += result.created;
    summary.updated += result.updated;
    summary.duplicates += result.duplicates;
    summary.processedCards += cardsToImport.length;
  }
  return summary;
}

async function handleImportSave() {
  if (window.__importing) {
    showToast("Importación en curso.", "error");
    return;
  }
  const parsed = elements.importPreview.dataset.parsed ? JSON.parse(elements.importPreview.dataset.parsed) : null;
  if (!parsed || !(parsed.blocks || []).length) {
    showToast("Previsualiza primero.", "error");
    return;
  }
  const totalCards = parsed.blocks.reduce((acc, block) => acc + block.cards.length, 0);
  if (!totalCards) {
    showToast("No hay tarjetas para importar.", "error");
    return;
  }
  if (!state.username) {
    showToast("Define tu usuario antes de importar.", "error");
    return;
  }
  if (isActiveFolderReadOnly()) {
    showToast("Carpeta compartida en solo lectura.", "error");
    return;
  }
  const db = getDb();
  const selectedImportFolderId = elements.importFolderSelect?.value || "__none__";
  const forceNoFolder = importState.mode !== "folder" && selectedImportFolderId === "__none__";
  const forcedFolderId = importState.mode === "folder"
    ? importState.forcedFolderId
    : (selectedImportFolderId !== "__none__" ? selectedImportFolderId : null);
  if (importState.mode === "folder" && !forcedFolderId) {
    showToast("Selecciona una carpeta antes de importar aquí.", "error");
    return;
  }
  window.__importing = true;
  elements.importSave.disabled = true;
  console.log("IMPORT START", { parsed: totalCards, forcedFolderId, forceNoFolder });
  try {
    const summary = await importBlocks(parsed.blocks, {
      forcedFolderId,
      forceNoFolder,
      folderFallback: "Importadas",
    });
    if (parsed.glossary && parsed.glossary.length) {
      const entries = await Promise.all(
        parsed.glossary.map(async (entry) => {
          const norm = normalizeWordCacheKey(entry.word);
          if (!norm) return null;
          const key = await buildWordKey(norm);
          return {
            key,
            word: entry.word,
            meaning: entry.meaning,
            tags: {},
            norm,
          };
        })
      );
      const validEntries = entries.filter((entry) => entry && entry.key && entry.meaning);
      if (validEntries.length) {
        await upsertGlossaryEntries(db, state.username, validEntries);
        validEntries.forEach((entry) => {
          state.glossaryCache.set(entry.norm, {
            key: entry.key,
            word: entry.word,
            meaning: entry.meaning,
            tags: [],
          });
        });
      }
    }
    elements.importText.value = "";
    const lines = [
      `Creadas: ${summary.created} | Actualizadas: ${summary.updated} | Duplicadas omitidas: ${summary.duplicates}`,
    ];
    if (importState.mode !== "folder") {
      lines.push(`Carpetas creadas: ${summary.createdFolders}`);
    }
    if (parsed.errors?.length) {
      lines.push("Errores:");
      parsed.errors.forEach((error) => lines.push(`- Línea ${error.line}: ${error.message}`));
    }
    const message = lines.join("\n");
    elements.importPreview.textContent = message;
    showToast(`Importadas: ${summary.created + summary.updated} | Duplicadas: ${summary.duplicates}`);
    await loadCards(true);
    console.log("IMPORT END", summary);
  } catch (error) {
    handleErrorToast(error, "No se pudo importar.");
  } finally {
    window.__importing = false;
    elements.importSave.disabled = false;
  }
}

function handleImportCancel() {
  if (elements.importText) {
    elements.importText.value = "";
  }
  resetImportPreview();
  const returnScreen = importState.mode === "folder" ? (importState.sourceScreen || "cards") : "import";
  setImportContext("generic", { sourceScreen: "import" });
  renderImportFolderSelect();
  if (returnScreen !== "import") {
    setActiveScreen(returnScreen);
  }
}

async function handleExportJson() {
  const db = getDb();
  const data = await fetchUserData(db, state.username);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chanki_${state.username}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function handleResetLocal() {
  if (confirm("¿Seguro? Se borrará localStorage.")) {
    localStorage.clear();
    location.reload();
  }
}

function applyTheme(theme = "dark") {
  const normalizedTheme = theme === "light" ? "light" : "dark";
  const isDark = normalizedTheme !== "light";
  document.documentElement.dataset.theme = normalizedTheme;
  document.documentElement.classList.toggle("theme-dark", isDark);
  document.documentElement.classList.toggle("theme-light", !isDark);
  document.body.classList.toggle("theme-dark", isDark);
  document.body.classList.toggle("theme-light", !isDark);
}

function handleSaveSettings() {
  const newUsername = elements.settingsUsername.value.trim();
  if (!newUsername) {
    showToast("El nombre de usuario es obligatorio.", "error");
    return;
  }
  if (newUsername && newUsername !== state.username) {
    if (confirm("Cambiar username cambia la raíz de datos.")) {
      localStorage.setItem("chanki_username", newUsername);
      location.reload();
      return;
    }
  }
  const maxNew = Number(elements.settingsMaxNew.value);
  const maxReviews = Number(elements.settingsMax.value);
  if (!Number.isNaN(maxNew)) {
    localStorage.setItem("chanki_max_new", String(maxNew));
    state.prefs.maxNew = maxNew;
  }
  if (!Number.isNaN(maxReviews)) {
    localStorage.setItem("chanki_max_reviews", String(maxReviews));
    state.prefs.maxReviews = maxReviews;
  }
  const clozeCase = elements.settingsClozeCase.checked;
  const themeDark = Boolean(elements.settingsThemeDark?.checked);
  applyTheme(themeDark ? "dark" : "light");
  localStorage.setItem("chanki_theme", themeDark ? "dark" : "light");
  localStorage.setItem("chanki_cloze_case", clozeCase ? "true" : "false");
  state.prefs.clozeCaseInsensitive = clozeCase;
  elements.reviewMaxNew.value = state.prefs.maxNew;
  elements.reviewMax.value = state.prefs.maxReviews;
  const darkMode = document.body.classList.contains("theme-dark");
  localStorage.setItem("chanki_theme", darkMode ? "dark" : "light");
  showToast("Preferencias guardadas.");
}

function getTagSelectionSet(scope) {
  if (scope === "review") return state.reviewSelectedTags;
  if (scope === "review-exclude") return state.reviewExcludeTags;
  return state.selectedTags;
}

function ensureTagPanels() {
  const cardPanel = document.querySelector('.tags-panel[data-tags-scope="card"]');
  if (!elements.cardTags?.dataset.tagsReady) {
    if (cardPanel) {
      cardPanel.dataset.collapsed = cardPanel.dataset.collapsed || "true";
      cardPanel.classList.toggle("is-collapsed", cardPanel.dataset.collapsed === "true");
      elements.cardTags.dataset.tagsReady = "true";
    } else {
      const cardField = elements.cardTags?.closest(".field");
      if (cardField) {
        const panel = document.createElement("div");
        panel.className = "tags-panel";
        panel.dataset.tagsScope = "card";
        panel.innerHTML = `
          <div class="tags-panel__section">
            <p class="tags-panel__label">Tags seleccionados</p>
            <div class="tags-chip-row" data-tags-selected></div>
          </div>
          <div class="tags-panel__section">
            <p class="tags-panel__label">Tags existentes</p>
            <div class="tags-chip-row" data-tags-all></div>
          </div>
          <div class="tags-suggestions hidden" data-tags-suggestions></div>
        `;
        cardField.insertAdjacentElement("afterend", panel);
        elements.cardTags.dataset.tagsReady = "true";
      }
    }
  }

  const buildReviewPanel = (field, scope, title) => {
    if (!field || field.dataset.tagsReady) return;
    const panel = document.createElement("div");
    panel.className = "tags-panel tags-panel--collapsible is-collapsed";
    panel.dataset.tagsScope = scope;
    panel.dataset.collapsed = "true";
    panel.innerHTML = `
      <button type="button" class="tags-panel__toggle" data-tags-toggle>
        <span>${title}</span>
        <span class="tags-panel__chevron" aria-hidden="true">▾</span>
      </button>
      <div class="tags-panel__content">
        <div class="tags-panel__section">
          <p class="tags-panel__label">Tags seleccionados</p>
          <div class="tags-chip-row" data-tags-selected></div>
        </div>
        <div class="tags-panel__section">
          <p class="tags-panel__label">Tags existentes</p>
          <div class="tags-chip-row" data-tags-all></div>
        </div>
        <div class="tags-suggestions hidden" data-tags-suggestions></div>
      </div>
    `;
    field.insertAdjacentElement("afterend", panel);
    field.dataset.tagsReady = "true";
  };

  buildReviewPanel(elements.reviewTags?.closest(".field"), "review", "Tags incluir");
  buildReviewPanel(elements.reviewTagsExclude?.closest(".field"), "review-exclude", "Tags excluir");
}

function renderTagPanels() {
  ensureTagPanels();
  document.querySelectorAll(".tags-panel").forEach((panel) => {
    const scope = panel.dataset.tagsScope;
    const selected = getTagSelectionSet(scope);
    const selectedContainer = panel.querySelector("[data-tags-selected]");
    const allContainer = panel.querySelector("[data-tags-all]");
    if (!selectedContainer || !allContainer || !selected) return;
    selectedContainer.innerHTML = "";
    allContainer.innerHTML = "";
    const selectedTags = Array.from(selected);
    const allTags = state.allTags.slice().sort();
    selectedTags.forEach((tag) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip tag-chip--selected";
      chip.dataset.tag = tag;
      chip.dataset.tagScope = scope;
      chip.textContent = tag;
      selectedContainer.appendChild(chip);
    });
    allTags.forEach((tag) => {
      const item = document.createElement("div");
      item.className = "tag-item";

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = selected.has(tag) ? "tag-chip tag-chip--selected" : "tag-chip";
      chip.dataset.tag = tag;
      chip.dataset.tagScope = scope;
      chip.textContent = tag;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tag-item__delete";
      remove.dataset.tagDeleteGlobal = tag;
      remove.setAttribute("aria-label", `Eliminar tag ${tag} globalmente`);
      remove.textContent = "✕";

      item.appendChild(chip);
      item.appendChild(remove);
      allContainer.appendChild(item);
    });
  });
}

function updateTagSuggestions(scope, query) {
  const panel = document.querySelector(`.tags-panel[data-tags-scope="${scope}"]`);
  if (!panel) return;
  const suggestionBox = panel.querySelector("[data-tags-suggestions]");
  if (!suggestionBox) return;
  if (panel.dataset.collapsed === "true") {
    suggestionBox.classList.add("hidden");
    suggestionBox.innerHTML = "";
    return;
  }
  const trimmed = normalizeSearchQuery(query);
  const selected = getTagSelectionSet(scope);
  if (!trimmed || !selected) {
    suggestionBox.classList.add("hidden");
    suggestionBox.innerHTML = "";
    return;
  }
  const matches = state.allTags.filter((tag) => tag.includes(trimmed) && !selected.has(tag));
  if (!matches.length) {
    suggestionBox.classList.add("hidden");
    suggestionBox.innerHTML = "";
    return;
  }
  suggestionBox.innerHTML = "";
  matches.slice(0, 6).forEach((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tag-suggestion";
    button.dataset.tag = tag;
    button.dataset.tagScope = scope;
    button.textContent = tag;
    suggestionBox.appendChild(button);
  });
  suggestionBox.classList.remove("hidden");
}

function addTagsToSelection(scope, tags) {
  const selected = getTagSelectionSet(scope);
  if (!selected) return;
  tags.forEach((tag) => selected.add(tag));
  renderTagPanels();
}

function handleTagInput(scope, inputEl, commitAll = false) {
  if (!inputEl) return;
  if (commitAll) {
    const tags = normalizeTags(inputEl.value);
    if (tags.length) {
      addTagsToSelection(scope, tags);
      inputEl.value = "";
    }
    updateTagSuggestions(scope, "");
    return;
  }
  const { tags, remainder } = splitTagInputValue(inputEl.value);
  if (tags.length) {
    addTagsToSelection(scope, tags);
    inputEl.value = remainder;
  }
  updateTagSuggestions(scope, inputEl.value);
}

function initTagsIndexListener() {
  if (tagsIndexUnsubscribe) {
    tagsIndexUnsubscribe();
    tagsIndexUnsubscribe = null;
  }
  if (!state.username) return;
  const db = getDb();
  tagsIndexUnsubscribe = listenTagsIndex(db, state.username, (tags) => {
    state.allTags = dedupeTags(tags);
    renderTagPanels();
  });
}

function initLexiconListener() {
  if (lexiconUnsubscribe) {
    lexiconUnsubscribe();
    lexiconUnsubscribe = null;
  }
  if (!state.username) {
    state.lexicon = {};
    return;
  }
  const db = getDb();
  lexiconUnsubscribe = listenLexicon(db, state.username, (lexicon) => {
    state.lexicon = lexicon || {};
    refreshCurrentReviewCard();
  });
}

function syncRouteFromState(screenName) {
  const screen = screenName || "folders";
  let path = "";
  const activeRef = getActiveFolderRef();
  if (screen === "cards" && activeRef?.folderId) {
    path = `folder/${encodeURIComponent(activeRef.folderId)}`;
  } else if (screen === "review") {
    path = "review";
  } else if (screen === "all-cards") {
    path = "cards/all";
  } else if (screen === "import") {
    path = "import";
  } else if (screen === "stats") {
    path = "stats";
  } else if (screen === "daily") {
    path = "daily";
  }
  updateBrowserRoute(path, "push");
}



function getFolderChoicePrompt() {
  const options = Object.values(state.folders || {});
  if (!options.length) return null;
  const lines = options.map((folder) => `${folder.id}:${folder.name}`).join("\n");
  return prompt(`Selecciona carpeta destino (id:nombre)\n${lines}`);
}

async function createCardFromDailyItem(type, item, extra = null) {
  if (!item) return;
  const db = getDb();
  const folderId = getFolderChoicePrompt();
  if (!folderId || !state.folders[folderId]) {
    showToast("Carpeta no válida.", "error");
    return null;
  }
  let front = item.german;
  let back = item.spanish;
  const tags = dedupeTags(["daily", type, ...(item.tags || [])]);
  if (type === "noun") {
    const bits = [item.spanish];
    if (item.article) bits.push(`Artículo: ${item.article}`);
    if (item.plural) bits.push(`Plural: ${item.plural}`);
    back = bits.join("\n");
  }
  if (type === "verb" && extra) {
    const tenseLines = Object.entries(extra)
      .map(([tense, values]) => `${tense}: ${Object.entries(values || {}).map(([k, v]) => `${k} ${v || ""}`).join(" · ")}`)
      .join("\n");
    if (tenseLines.trim()) back = `${item.spanish}\n\nConjugaciones (usuario):\n${tenseLines}`;
  }
  const id = `daily_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  const result = await upsertCardWithDedupe(db, state.username, {
    id,
    folderId,
    type: "basic",
    front,
    back,
    tags: tagsToMap(tags),
  });
  if (result.status === "duplicate") {
    showToast("Tarjeta duplicada omitida.");
    return { status: "duplicate", cardId: id, folderId };
  }
  showToast("Tarjeta creada.");
  return { status: "created", cardId: id, folderId };
}

async function openFolderView({ ownerUid, folderId, role = "owner", isShared = false }, routeMode = "push") {
  state.selectedFolderId = folderId;
  state.activeFolderRef = { ownerUid, folderId, role, isShared };
  state.cardsSearchPool = [];
  state.cardsSearchFolderId = null;
  state.cardsSearchOwnerUid = null;
  updateCardsTitle();
  updateSearchUI();
  await loadCards(true);
  if (state.cardsSearchQuery) {
    loadSearchPool();
  }
  updateFolderAccessUI();
  setActiveScreen("cards", { skipRouteSync: true });
  if (routeMode === "replace") {
    updateBrowserRoute(`folder/${encodeURIComponent(folderId)}`, "replace");
  } else if (routeMode === "push") {
    updateBrowserRoute(`folder/${encodeURIComponent(folderId)}`, "push");
  }
}

async function applyRoute() {
  const path = getRouteWithinApp();
  if (path.startsWith("/folder/")) {
    const folderId = decodeURIComponent(path.replace("/folder/", ""));
    if (!folderId) {
      setActiveScreen("folders", { skipRouteSync: true });
      return;
    }
    const ownedFolderId = resolveOwnedFolderId(folderId);
    if (ownedFolderId) {
      await openFolderView({ ownerUid: state.username, folderId: ownedFolderId, role: "owner", isShared: false }, "replace");
      return;
    }
    const shared = Object.values(state.sharedFolders || {}).find((entry) => entry?.folderId === folderId);
    if (shared) {
      await openFolderView({ ownerUid: shared.ownerUid, folderId, role: shared.role || "viewer", isShared: true }, "replace");
      return;
    }
    showToast("Carpeta no encontrada.", "error");
    setActiveScreen("folders", { skipRouteSync: true });
    updateBrowserRoute("", "replace");
    return;
  }
  if (path === "/cards/all") {
    setActiveScreen("all-cards", { skipRouteSync: true });
    renderAllCardsView();
    return;
  }
  if (path === "/import") {
    setActiveScreen("import", { skipRouteSync: true });
    return;
  }
  if (path === "/review") {
    setActiveScreen("review", { skipRouteSync: true });
    return;
  }
  if (path === "/stats") {
    setActiveScreen("stats", { skipRouteSync: true });
    return;
  }
  if (path === "/daily") {
    setActiveScreen("daily", { skipRouteSync: true });
    return;
  }
  setActiveScreen("folders", { skipRouteSync: true });
}

function initApp() {
  if (!state.username) {
    showOverlay(elements.overlay, true);
    setStatus("Define un usuario para empezar.");
    return;
  }

  initFirebaseUi();
}

async function initFirebaseUi() {
  getDb();
  restoreReviewSelectorPrefs();
  sanitizeReviewFolderSelections();
  setStatus(`Usuario: ${state.username}`);
  syncUsersPublic();
  initFolders();
  initCardCountsListener();
  initSharedFolders();
  state.activeFolderRef = null;
  runFolderIdMigration();
  runDedupeMigration();
  loadStats();
  updateSearchUI();
  initLexiconListener();
  initTagsIndexListener();
  ensureTagPanels();
  if (elements.reviewTags) elements.reviewTags.value = "";
  if (elements.reviewTagsExclude) elements.reviewTagsExclude.value = "";
  renderTagPanels();
  if (elements.reviewEditCard) {
    elements.reviewEditCard.disabled = true;
  }
  elements.reviewMaxNew.value = state.prefs.maxNew;
  elements.reviewMax.value = state.prefs.maxReviews;
  elements.settingsUsername.value = state.username;
  elements.settingsMaxNew.value = state.prefs.maxNew;
  elements.settingsMax.value = state.prefs.maxReviews;
  elements.settingsClozeCase.checked = state.prefs.clozeCaseInsensitive;
  const savedTheme = localStorage.getItem("chanki_theme") || "dark";
  applyTheme(savedTheme);
  if (elements.settingsThemeDark) elements.settingsThemeDark.checked = savedTheme !== "light";
  renderBucketFilter();
  refreshReviewBucketCounts();
  setImportContext("generic", { sourceScreen: "import" });
  renderImportFolderSelect();
  await initDailyScreen({
    getDb,
    state,
    elements,
    showToast,
    createCardFromDailyItem,
  });
  applyRoute();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => null);
  });
}

updateStandaloneHint();
const displayModeQuery = window.matchMedia("(display-mode: standalone)");
if (typeof displayModeQuery.addEventListener === "function") {
  displayModeQuery.addEventListener("change", updateStandaloneHint);
} else if (typeof displayModeQuery.addListener === "function") {
  displayModeQuery.addListener(updateStandaloneHint);
}

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.screen === "import") {
      setImportContext("generic", { sourceScreen: "import" });
      resetImportPreview();
    }
    setActiveScreen(tab.dataset.screen);
    if (tab.dataset.screen === "all-cards") {
      renderAllCardsView();
    }
    if (tab.dataset.screen === "daily") {
      initDailyScreen({ getDb, state, elements, showToast, createCardFromDailyItem });
    }
  });
});

if (elements.backToFolders) {
  elements.backToFolders.addEventListener("click", () => setActiveScreen("folders"));
}

if (elements.saveUsername) {
  elements.saveUsername.addEventListener("click", () => {
    const name = elements.usernameInput.value.trim();
    if (!name) {
      showToast("El nombre de usuario es obligatorio.", "error");
      return;
    }
    localStorage.setItem("chanki_username", name);
    state.username = name;
    showOverlay(elements.overlay, false);
    initApp();
  });
}

elements.addFolder.addEventListener("click", handleAddFolder);
if (elements.addSubfolder) { elements.addSubfolder.addEventListener("click", () => { if (!state.folderBrowseId) return showToast("Abre una carpeta primero.", "info"); openFolderModal(); }); }
if (elements.folderSelectToggle) elements.folderSelectToggle.addEventListener("click", () => setFolderSelectionMode(!state.folderSelectionMode));
if (elements.folderBulkCancel) elements.folderBulkCancel.addEventListener("click", () => setFolderSelectionMode(false));
if (elements.folderBulkMove) elements.folderBulkMove.addEventListener("click", () => {
  const selected = [...(state.selectedFolderIds || new Set())];
  if (!selected.length) return showToast("Selecciona al menos una carpeta.", "error");
  const excluded = new Set(selected);
  selected.forEach((id) => getFolderDescendantIds(id).forEach((d) => excluded.add(d)));
  const browseId = state.folderBrowseId || null;
  const candidates = Object.values(state.folders || {}).filter((f) => !excluded.has(f.id));
  if (elements.folderMoveTargetList) {
    elements.folderMoveTargetList.innerHTML = `<button class="button ghost small" data-target-parent="">Raíz</button>${candidates.map((f) => `<button class="button ghost small" data-target-parent="${f.id}">${f.name}</button>`).join("")}`;
  }
  showOverlay(elements.folderMoveModal, true);
});
if (elements.folderMoveTargetList) elements.folderMoveTargetList.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-target-parent]");
  if (!btn) return;
  await moveFoldersToParent([...(state.selectedFolderIds || new Set())], btn.dataset.targetParent || null);
  showOverlay(elements.folderMoveModal, false);
  setFolderSelectionMode(false);
});
if (elements.folderMoveCancel) elements.folderMoveCancel.addEventListener("click", () => showOverlay(elements.folderMoveModal, false));
if (elements.folderBulkGroup) elements.folderBulkGroup.addEventListener("click", () => showOverlay(elements.folderGroupModal, true));
if (elements.folderGroupCancel) elements.folderGroupCancel.addEventListener("click", () => showOverlay(elements.folderGroupModal, false));
if (elements.folderGroupConfirm) elements.folderGroupConfirm.addEventListener("click", async () => {
  const name = String(elements.folderGroupName?.value || "").trim();
  if (!name) return showToast("Pon un nombre.", "error");
  const db = getDb();
  const createdFolderId = await createFolder(db, state.username, { name, emoji: "📁", color: "#8b5cf6", reviewBothSides: false, sourceLang: "es", targetLang: "de", parentId: state.folderBrowseId || null });
  await moveFoldersToParent([...(state.selectedFolderIds || new Set())], createdFolderId || null);
  showOverlay(elements.folderGroupModal, false);
  if (elements.folderGroupName) elements.folderGroupName.value = "";
  setFolderSelectionMode(false);
});

elements.folderTree.addEventListener("click", handleFolderAction);
if (elements.folderTree) {
  elements.folderTree.addEventListener("pointerdown", handleFolderLongPressStart);
  elements.folderTree.addEventListener("pointerup", cancelFolderLongPress);
  elements.folderTree.addEventListener("pointercancel", cancelFolderLongPress);
  elements.folderTree.addEventListener("pointerleave", cancelFolderLongPress);
  elements.folderTree.addEventListener("dragstart", handleFolderDragStart);
  elements.folderTree.addEventListener("dragover", handleFolderDragOver);
  elements.folderTree.addEventListener("drop", handleFolderDrop);
  elements.folderTree.addEventListener("dragend", () => { state.movingFolderId = null; document.querySelectorAll(".folder-row").forEach((el)=>el.classList.remove("is-dragging","is-drop-target")); });
}

if (elements.saveFolder) {
  elements.saveFolder.addEventListener("click", handleSaveFolder);
}

if (elements.cancelFolder) {
  elements.cancelFolder.addEventListener("click", closeFolderModal);
}

if (elements.folderModal) {
  elements.folderModal.addEventListener("click", (event) => {
    if (event.target === elements.folderModal) {
      closeFolderModal();
    }
  });
}

if (elements.shareModal) {
  elements.shareModal.addEventListener("click", (event) => {
    if (event.target === elements.shareModal) {
      closeShareModal();
    }
  });
}

if (elements.shareClose) {
  elements.shareClose.addEventListener("click", closeShareModal);
}

if (elements.shareUserSearch) {
  elements.shareUserSearch.addEventListener("input", () => {
    if (shareSearchTimer) {
      clearTimeout(shareSearchTimer);
    }
    shareSearchTimer = setTimeout(() => {
      renderShareResults();
    }, 250);
  });
}

if (elements.shareResults) {
  elements.shareResults.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-share-uid]");
    if (!target || !shareContext) return;
    const sharedUid = target.dataset.shareUid;
    if (!sharedUid) return;
    try {
      const db = getDb();
      const selectedGender = wordPopover.dataset.gender || "";
      const role = elements.shareRoleToggle?.checked ? "editor" : "viewer";
      await shareFolder(db, {
        ownerUid: shareContext.ownerUid,
        folderId: shareContext.folderId,
        sharedUid,
        role,
        addedBy: state.username,
      });
      showToast("Carpeta compartida.");
      if (elements.shareUserSearch) {
        elements.shareUserSearch.value = "";
      }
      renderShareResults();
    } catch (error) {
      handleErrorToast(error, "No se pudo compartir.");
    }
  });
}

if (elements.shareCurrentList) {
  elements.shareCurrentList.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-unshare-uid]");
    if (!target || !shareContext) return;
    const sharedUid = target.dataset.unshareUid;
    if (!sharedUid) return;
    try {
      const db = getDb();
      const selectedGender = wordPopover.dataset.gender || "";
      await unshareFolder(db, {
        ownerUid: shareContext.ownerUid,
        folderId: shareContext.folderId,
        sharedUid,
      });
      showToast("Acceso revocado.");
    } catch (error) {
      handleErrorToast(error, "No se pudo revocar el acceso.");
    }
  });
}

elements.addCard.addEventListener("click", () => {
  if (isActiveFolderReadOnly()) {
    showToast("Carpeta compartida en solo lectura.", "error");
    return;
  }
  openCardModal();
});

if (elements.addCardFromFolders) {
  elements.addCardFromFolders.addEventListener("click", () => {
    if (!Object.keys(state.folders || {}).length) {
      showToast("Crea una carpeta antes de añadir tarjetas.", "error");
    }
    openCardModal();
  });
}

if (elements.importFolder) {
  elements.importFolder.addEventListener("click", () => {
    if (isActiveFolderReadOnly()) {
      showToast("Carpeta compartida en solo lectura.", "error");
      return;
    }
    const folder = getActiveFolderInfo();
    if (!folder || !state.selectedFolderId) {
      showToast("Selecciona una carpeta primero.", "error");
      return;
    }
    setImportContext("folder", {
      forcedFolderId: state.selectedFolderId,
      forcedFolderLabel: folder.name,
      sourceScreen: "cards",
    });
    resetImportPreview();
    setActiveScreen("import");
  });
}

elements.cardsList.addEventListener("click", handleCardListAction);

if (elements.allCardsList) {
  elements.allCardsList.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const cardId = actionEl.dataset.id;
    const groupId = actionEl.dataset.groupId;
    if (action === "toggle-collapse" && groupId) {
      if (state.allCardsCollapsedGroups.has(groupId)) state.allCardsCollapsedGroups.delete(groupId);
      else state.allCardsCollapsedGroups.add(groupId);
      renderAllCardsView();
      return;
    }
    if (!cardId) return;
    if (action === "open") {
      const card = (state.allCards || []).find((entry) => entry.id === cardId);
      if (card) openCardModal(card);
    }
  });
  elements.allCardsList.addEventListener("change", (event) => {
    const input = event.target.closest('input[type="checkbox"][data-action]');
    if (!input) return;
    const action = input.dataset.action;
    const cardId = input.dataset.id;
    const groupId = input.dataset.groupId;
    if (action === "toggle-card" && cardId) {
      if (input.checked) state.allCardsSelectedIds.add(cardId);
      else state.allCardsSelectedIds.delete(cardId);
      updateAllCardsBulkBar((state.allCards || []).length);
      return;
    }
    if (action === "toggle-group" && groupId) {
      const groupCards = (state.allCards || []).filter((card) => (card.folderId || "__unassigned__") === groupId);
      groupCards.forEach((card) => {
        if (input.checked) state.allCardsSelectedIds.add(card.id);
        else state.allCardsSelectedIds.delete(card.id);
      });
      renderAllCardsView();
    }
  });
}

if (elements.allCardsSelectAll) {
  elements.allCardsSelectAll.addEventListener("click", () => {
    state.allCardsSelectedIds = new Set((state.allCards || []).map((card) => card.id));
    renderAllCardsView();
  });
}

if (elements.allCardsClearAll) {
  elements.allCardsClearAll.addEventListener("click", () => {
    state.allCardsSelectedIds = new Set();
    renderAllCardsView();
  });
}

if (elements.allCardsMove) {
  elements.allCardsMove.addEventListener("click", async () => {
    const ids = [...state.allCardsSelectedIds];
    if (!ids.length) return;
    const selectedTarget = elements.allCardsMoveTarget?.value;
    if (!selectedTarget) {
      showToast("Selecciona una carpeta destino.", "error");
      return;
    }
    if (selectedTarget !== "__none__" && !state.folders[selectedTarget]) {
      showToast("La carpeta destino ya no existe.", "error");
      return;
    }
    const db = getDb();
    const moveToFolderId = selectedTarget === "__none__" ? null : selectedTarget;
    for (const id of ids) {
      const card = (state.allCards || []).find((entry) => entry.id === id);
      if (!card) continue;
      await moveCardFolder(db, state.username, card, moveToFolderId);
      state.allCardsSelectedIds.delete(id);
    }
    if (elements.allCardsMoveTarget) elements.allCardsMoveTarget.value = "";
    showToast("Tarjetas movidas.");
    renderAllCardsView();
  });
}

if (elements.allCardsDelete) {
  elements.allCardsDelete.addEventListener("click", async () => {
    const ids = [...state.allCardsSelectedIds];
    if (!ids.length) return;
    if (!window.confirm(`¿Borrar ${ids.length} tarjetas seleccionadas?`)) return;
    const db = getDb();
    for (const id of ids) {
      const card = (state.allCards || []).find((entry) => entry.id === id);
      if (!card) continue;
      await deleteCard(db, state.username, card);
      state.allCardsSelectedIds.delete(id);
    }
    showToast("Tarjetas eliminadas.");
    renderAllCardsView();
  });
}

if (elements.cardsSelectToggle) {
  elements.cardsSelectToggle.addEventListener("click", () => {
    state.cardsSelectionMode = !state.cardsSelectionMode;
    if (!state.cardsSelectionMode) state.selectedCardIds = new Set();
    updateCardsBulkToolbar();
    renderCardsView();
  });
}

if (elements.cardsBulkDelete) {
  elements.cardsBulkDelete.addEventListener("click", async () => {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    if (!window.confirm(`¿Borrar ${ids.length} tarjetas seleccionadas?`)) return;
    const db = getDb();
    const ownerUid = getActiveOwnerUid();
    for (const id of ids) {
      const card = state.cards.find((entry) => entry.id === id);
      if (card) await deleteCard(db, ownerUid, card);
    }
    state.selectedCardIds = new Set();
    await loadCards(true);
  });
}

if (elements.cardsBulkMove) {
  elements.cardsBulkMove.addEventListener("click", async () => {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    const folderOptions = Object.values(state.folders).map((folder) => `${folder.id}:${folder.name}`).join("\n");
    const newFolderId = prompt(`Mover seleccionadas a carpeta (id:nombre)\n${folderOptions}`);
    if (!newFolderId || !state.folders[newFolderId]) return;
    const db = getDb();
    const ownerUid = getActiveOwnerUid();
    for (const id of ids) {
      const card = state.cards.find((entry) => entry.id === id);
      if (card) await moveCardFolder(db, ownerUid, card, newFolderId);
    }
    state.selectedCardIds = new Set();
    await loadCards(true);
  });
}

if (elements.cardsBulkClearFolder) {
  elements.cardsBulkClearFolder.addEventListener("click", async () => {
    const ids = [...state.selectedCardIds];
    if (!ids.length) return;
    const db = getDb();
    const ownerUid = getActiveOwnerUid();
    for (const id of ids) {
      await updateCard(db, ownerUid, id, { folderId: null });
    }
    state.selectedCardIds = new Set();
    await loadCards(true);
  });
}

if (elements.cardsDupToggle) {
  elements.cardsDupToggle.addEventListener("click", () => {
    state.showOnlyDuplicates = !state.showOnlyDuplicates;
    renderCards();
  });
}

if (elements.cardType) {
  elements.cardType.addEventListener("change", (event) => {
    updateCardTypeFields(event.target.value);
  });
}
if (elements.cardFolderSelect) {
  elements.cardFolderSelect.addEventListener("pointerdown", () => {
    if (!elements.cardModal || elements.cardModal.classList.contains("hidden")) return;
    renderCardFolderSelector({
      openedFromFoldersRoot: !elements.cardFolderField.classList.contains("hidden"),
      selectedFolderId: elements.cardFolderSelect.value || state.cardModalLastSelectedFolderId || state.selectedFolderId || "",
      disableSelection: Boolean(editingCardId),
    });
  });
  elements.cardFolderSelect.addEventListener("change", () => {
    state.cardModalLastSelectedFolderId = elements.cardFolderSelect.value || "";
  });
}

const cardOrderSplitButton = document.getElementById("card-order-split");
const cardOrderGroupButton = document.getElementById("card-order-group");
const cardOrderUngroupButton = document.getElementById("card-order-ungroup");
const cardOrderAddLabelButton = document.getElementById("card-order-add-label");
const cardOrderTokenChips = document.getElementById("card-order-token-chips");
const cardOrderLabelChips = document.getElementById("card-order-label-chips");

if (cardOrderSplitButton) {
  cardOrderSplitButton.addEventListener("click", () => {
    const target = String(elements.cardBack?.value || "").trim();
    if (!target) {
      showToast("Escribe TARGET_DE primero.", "error");
      return;
    }
    const chunks = target.split(/\s+/).map((part) => part.trim()).filter(Boolean);
    if (!chunks.length) {
      showToast("No se pudieron extraer tokens.", "error");
      return;
    }
    orderEditorState.chunks = chunks.map((text, index) => ({ id: `t${index}`, text }));
    orderEditorState.tokenLabels = {};
    orderEditorState.selectedTokenIds = new Set();
    renderOrderEditor();
    showToast(`Generados ${chunks.length} chunks.`);
  });
}

if (cardOrderLabelChips) {
  cardOrderLabelChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-label-id]");
    if (!chip) return;
    orderEditorState.activeLabelId = chip.dataset.labelId;
    renderOrderEditor();
  });
}

if (cardOrderTokenChips) {
  cardOrderTokenChips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-token-id]");
    if (!chip) return;
    const tokenId = chip.dataset.tokenId;
    if (!tokenId) return;
    if (orderEditorState.activeLabelId) {
      orderEditorState.tokenLabels[tokenId] = orderEditorState.activeLabelId;
    }
    if (orderEditorState.selectedTokenIds.has(tokenId)) {
      orderEditorState.selectedTokenIds.delete(tokenId);
    } else {
      orderEditorState.selectedTokenIds.add(tokenId);
    }
    renderOrderEditor();
  });
  cardOrderTokenChips.addEventListener("contextmenu", (event) => {
    const chip = event.target.closest("[data-token-id]");
    if (!chip) return;
    event.preventDefault();
    const tokenId = chip.dataset.tokenId;
    if (!tokenId) return;
    const action = prompt("Acción: quitar / cambiar", "quitar");
    if (!action) return;
    if (action.toLowerCase().startsWith("q")) {
      delete orderEditorState.tokenLabels[tokenId];
      renderOrderEditor();
      return;
    }
    const labelText = prompt("Nuevo label", "");
    if (!labelText) return;
    let label = (orderEditorState.labelsCatalog || []).find((entry) => entry.text.toLowerCase() === labelText.toLowerCase());
    if (!label) {
      label = {
        id: `lbl_${Date.now()}`,
        text: labelText.trim(),
        color: ORDER_LABEL_COLORS[(orderEditorState.labelsCatalog || []).length % ORDER_LABEL_COLORS.length],
      };
      orderEditorState.labelsCatalog.push(label);
    }
    orderEditorState.tokenLabels[tokenId] = label.id;
    orderEditorState.activeLabelId = label.id;
    renderOrderEditor();
  });
}

if (cardOrderGroupButton) {
  cardOrderGroupButton.addEventListener("click", () => {
    const selectedIds = orderEditorState.chunks
      .map((chunk) => chunk.id)
      .filter((id) => orderEditorState.selectedTokenIds.has(id));
    if (selectedIds.length < 2) {
      showToast("Selecciona al menos 2 tokens contiguos.", "error");
      return;
    }
    const indexes = selectedIds.map((id) => orderEditorState.chunks.findIndex((chunk) => chunk.id === id));
    const min = Math.min(...indexes);
    const max = Math.max(...indexes);
    if (max - min + 1 !== selectedIds.length) {
      showToast("Solo se pueden agrupar tokens contiguos.", "error");
      return;
    }
    const group = orderEditorState.chunks.slice(min, max + 1);
    const mergedText = group.map((chunk) => chunk.text).join(" ");
    const mergedId = `t${Date.now()}`;
    const mergedLabel = orderEditorState.tokenLabels[group[0].id] || null;
    orderEditorState.chunks.splice(min, group.length, { id: mergedId, text: mergedText });
    group.forEach((chunk) => delete orderEditorState.tokenLabels[chunk.id]);
    if (mergedLabel) orderEditorState.tokenLabels[mergedId] = mergedLabel;
    orderEditorState.selectedTokenIds = new Set([mergedId]);
    renderOrderEditor();
  });
}

if (cardOrderUngroupButton) {
  cardOrderUngroupButton.addEventListener("click", () => {
    const selectedId = [...orderEditorState.selectedTokenIds][0];
    if (!selectedId) {
      showToast("Selecciona un chunk agrupado.", "error");
      return;
    }
    const index = orderEditorState.chunks.findIndex((chunk) => chunk.id === selectedId);
    if (index < 0) return;
    const chunk = orderEditorState.chunks[index];
    const parts = String(chunk.text || "").split(/\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      showToast("Ese chunk no se puede desagrupar.", "error");
      return;
    }
    const labelId = orderEditorState.tokenLabels[selectedId];
    delete orderEditorState.tokenLabels[selectedId];
    const replacements = parts.map((text, idx) => ({ id: `${selectedId}_${idx}`, text }));
    orderEditorState.chunks.splice(index, 1, ...replacements);
    if (labelId) replacements.forEach((item) => { orderEditorState.tokenLabels[item.id] = labelId; });
    orderEditorState.selectedTokenIds = new Set(replacements.map((item) => item.id));
    renderOrderEditor();
  });
}

if (cardOrderAddLabelButton) {
  cardOrderAddLabelButton.addEventListener("click", () => {
    const text = prompt("Nuevo label", "");
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const existing = (orderEditorState.labelsCatalog || []).find((label) => label.text.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      orderEditorState.activeLabelId = existing.id;
      renderOrderEditor();
      return;
    }
    const label = {
      id: `lbl_${Date.now()}`,
      text: trimmed,
      color: ORDER_LABEL_COLORS[(orderEditorState.labelsCatalog || []).length % ORDER_LABEL_COLORS.length],
    };
    orderEditorState.labelsCatalog.push(label);
    orderEditorState.activeLabelId = label.id;
    renderOrderEditor();
  });
}


if (elements.cardFront) elements.cardFront.addEventListener("input", () => {
  cardFrontManuallyEdited = true;
  autoResizeTextarea(elements.cardFront);
  console.info("[translate:auto-disabled]", { field: "front" });
  refreshTranslateCta();
});
if (elements.cardFront) elements.cardFront.addEventListener("focus", (event) => { maybeSeedNumberedTextarea(event); autoResizeTextarea(elements.cardFront); });
if (elements.cardBack) elements.cardBack.addEventListener("focus", (event) => { maybeSeedNumberedTextarea(event); autoResizeTextarea(elements.cardBack); });
if (elements.cardFront) elements.cardFront.addEventListener("keydown", maybeHandleNumberedEnter);
if (elements.cardBack) elements.cardBack.addEventListener("keydown", maybeHandleNumberedEnter);
if (elements.cardGrammarType) {
  const handleGrammarTypePointer = (event) => {
    const button = event.target.closest("[data-grammar-type]");
    if (!button) return;
    const next = button.dataset.grammarType || "normal";
    console.info("[grammar:click]", { next, eventType: event.type });
    setGrammarType(next);
  };
  elements.cardGrammarType.addEventListener("click", handleGrammarTypePointer);
  elements.cardGrammarType.addEventListener("touchstart", handleGrammarTypePointer, { passive: true });
}
if (elements.cardNounGender) {
  elements.cardNounGender.addEventListener("click", (event) => {
    const button = event.target.closest("[data-noun-gender]");
    if (!button) return;
    cardNounGender = button.dataset.nounGender || null;
    syncGrammarControls();
  });
}
if (elements.cardVerbPaste) {
  elements.cardVerbPaste.addEventListener("paste", (event) => {
    const pasted = event.clipboardData?.getData("text") || "";
    if (!pasted.trim()) return;
    event.preventDefault();
    applyReversoConjugationPaste(pasted);
  });
}
if (elements.cardFront) elements.cardFront.addEventListener("paste", () => setTimeout(() => autoResizeTextarea(elements.cardFront), 0));
if (elements.cardBack) elements.cardBack.addEventListener("paste", () => setTimeout(() => autoResizeTextarea(elements.cardBack), 0));
if (elements.cardBack) elements.cardBack.addEventListener("input", () => {
  cardBackManuallyEdited = true;
  autoResizeTextarea(elements.cardBack);
  console.info("[translate:auto-disabled]", { field: "back" });
  refreshTranslateCta();
  updateVerbReversoLink();
});
if (elements.cardTranslate) elements.cardTranslate.addEventListener("click", async () => {
  console.info("[translate:manual-click]");
  const front = String(elements.cardFront?.value || "").trim();
  const back = String(elements.cardBack?.value || "").trim();
  if (front && !back) {
    if (isSingleWord(front)) elements.cardTranslateContextField?.classList.remove("hidden");
    return runCardTranslation("source-target");
  }
  if (back && !front) {
    if (isSingleWord(back)) elements.cardTranslateContextField?.classList.remove("hidden");
    return runCardTranslation("target-source");
  }
  if (front && back) {
    elements.cardTranslateEsDe?.classList.remove("hidden");
    elements.cardTranslateDeEs?.classList.remove("hidden");
    const { sourceLang, targetLang } = getActiveFolderLanguages();
    const sourceName = LANGUAGE_LABELS[sourceLang] || sourceLang.toUpperCase();
    const targetName = LANGUAGE_LABELS[targetLang] || targetLang.toUpperCase();
    if (elements.cardTranslateEsDe) elements.cardTranslateEsDe.textContent = `Traducir ${sourceName} → ${targetName}`;
    if (elements.cardTranslateDeEs) elements.cardTranslateDeEs.textContent = `Traducir ${targetName} → ${sourceName}`;
    setTranslateStatus("Elige dirección");
    return;
  }
  showToast("Escribe texto para traducir.", "info");
});
if (elements.cardTranslateEsDe) elements.cardTranslateEsDe.addEventListener("click", () => runCardTranslation("source-target", { force: true }));
if (elements.cardTranslateDeEs) elements.cardTranslateDeEs.addEventListener("click", () => runCardTranslation("target-source", { force: true }));
if (elements.cardClear) elements.cardClear.addEventListener("click", () => {
  if (elements.cardFront) elements.cardFront.value = "";
  if (elements.cardBack) elements.cardBack.value = currentGrammarType === "verb" ? VERB_TEMPLATE : "";
  if (elements.cardExample) elements.cardExample.value = "";
  autoResizeTextarea(elements.cardFront);
  autoResizeTextarea(elements.cardBack);
  autoResizeTextarea(elements.cardExample);
  elements.cardFront?.focus();
});
elements.saveCard.addEventListener("click", handleSaveCard);

elements.cancelCard.addEventListener("click", closeCardModal);

if (elements.cardModalClose) {
  elements.cardModalClose.addEventListener("click", closeCardModal);
}

if (elements.reviewCard) {
  elements.reviewCard.addEventListener("click", (event) => {
    const wordEl = event.target.closest(".word");
    if (!wordEl) return;
    event.stopPropagation();
    const word = wordEl.dataset.word;
      if (word) {
        const langChunk = wordEl.closest(".lang-chunk");
        const language = langChunk?.dataset.language
          || (wordEl.closest(".review-front") ? "de" : "es");
        const card = state.reviewQueue[state.currentIndex];
        const context = getReviewCardContext(card);
        state.activeWordContext = {
          language,
          cardId: card?.id || null,
          folderId: card?.folderId || null,
          ownerUid: context.ownerUid || state.username,
          role: context.role,
          isShared: context.isShared,
        };
        openWordPopover(word, wordEl.getBoundingClientRect());
      }
  });
  elements.reviewCard.addEventListener("pointerdown", handleReviewPointerDown);
  elements.reviewCard.addEventListener("pointermove", handleReviewPointerMove);
  elements.reviewCard.addEventListener("pointerup", finalizeSwipe);
  elements.reviewCard.addEventListener("pointercancel", finalizeSwipe);
}

elements.startReview.addEventListener("click", async () => {
  await buildReviewQueue();
  if (!state.reviewQueue.length) {
    showToast(state.reviewLastEmptyReason || "No hay tarjetas para repasar con esos filtros.", "error");
    state.sessionActive = false;
    state.sessionTotal = 0;
    return;
  }
  state.sessionStart = Date.now();
  state.lastReviewAt = Date.now();
  state.sessionStats = {
    startTime: Date.now(),
    answeredCount: 0,
  };
  state.sessionActive = true;
  state.sessionTotal = state.reviewQueue.length;
  state.reviewFolderName = buildReviewFolderLabel();
  if (elements.reviewPlayerFolder) {
    elements.reviewPlayerFolder.textContent = state.reviewFolderName;
  }
  setReviewMode(true);
  showNextReviewCard();
});

if (elements.reviewBucketChart) {
  elements.reviewBucketChart.addEventListener("click", (event) => {
    const bar = event.target.closest(".bucket-bar");
    if (!bar) return;
    const bucket = canonicalizeBucketId(bar.dataset.bucket);
    if (!bucket) return;
    state.reviewBuckets[bucket] = !state.reviewBuckets[bucket];
    renderBucketFilter();
    refreshReviewBucketCounts();
  });
}

function getCheckedReviewFolderIds() {
  return [...(state.reviewSelectedFolderIds || [])];
}

async function deleteTagGlobally(tagToDelete) {
  const [tag] = normalizeTags(tagToDelete || "");
  if (!tag) {
    showToast("Tag inválido.", "error");
    return;
  }
  const db = getDb();
  const allCards = await fetchCardsForSearch(db, state.username, null, 5000);
  const affected = allCards.filter((card) => mapToTags(card.tags || {}).includes(tag));
  if (!affected.length) {
    showToast("Ese tag no existe en tus fichas.");
    return;
  }
  const confirmed = window.confirm(`Eliminar el tag '${tag}' de todas las tarjetas?`);
  if (!confirmed) return;
  let done = 0;
  for (const card of affected) {
    const tags = new Set(mapToTags(card.tags || {}));
    tags.delete(tag);
    await updateCard(db, state.username, card.id, { tags: tagsToMap([...tags]) });
    done += 1;
  }
  showToast(`Tag "${tag}" eliminado de ${done} fichas.`, "success");
  refreshReviewBucketCounts();
  renderTagPanels();
}

if (elements.reviewFolderTrigger) {
  elements.reviewFolderTrigger.addEventListener("click", () => {
    if (elements.reviewFolderSearch) {
      elements.reviewFolderSearch.value = state.reviewFolderSearchQuery || "";
    }
    renderFolderSelects();
    showOverlay(elements.reviewFolderModal, true);
  });
}

if (elements.reviewFolderClose) {
  elements.reviewFolderClose.addEventListener("click", () => {
    showOverlay(elements.reviewFolderModal, false);
  });
}

if (elements.reviewFolderModal) {
  elements.reviewFolderModal.addEventListener("click", (event) => {
    if (event.target === elements.reviewFolderModal) {
      showOverlay(elements.reviewFolderModal, false);
    }
  });
}

if (elements.reviewFolderSearch) {
  elements.reviewFolderSearch.addEventListener("input", (event) => {
    state.reviewFolderSearchQuery = event.target.value || "";
    clearTimeout(reviewFolderSearchDebounce);
    reviewFolderSearchDebounce = setTimeout(() => {
      renderFolderSelects();
      persistReviewSelectorPrefs();
    }, 120);
  });
}

if (elements.reviewFolderOptions) {
  elements.reviewFolderOptions.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-folder-id]");
    if (!chip) return;
    const folderId = chip.dataset.folderId;
    const selected = new Set(state.reviewSelectedFolderIds || []);
    if (selected.has(folderId)) selected.delete(folderId);
    else selected.add(folderId);
    state.reviewSelectedFolderIds = [...selected];
    persistReviewSelectorPrefs();
    renderFolderSelects();
  });
}

if (elements.reviewFolderSelectAll) {
  elements.reviewFolderSelectAll.addEventListener("click", () => {
    state.reviewSelectedFolderIds = getVisibleReviewFolderOptionIds();
    persistReviewSelectorPrefs();
    renderFolderSelects();
  });
}
if (elements.reviewFolderSelectNone) {
  elements.reviewFolderSelectNone.addEventListener("click", () => { state.reviewSelectedFolderIds = []; persistReviewSelectorPrefs(); renderFolderSelects(); });
}
if (elements.reviewFolderResetPreferences) {
  elements.reviewFolderResetPreferences.addEventListener("click", resetReviewSelectorPrefs);
}

if (elements.reviewFolderApply) {
  elements.reviewFolderApply.addEventListener("click", () => {
    const selected = getCheckedReviewFolderIds();
    state.reviewSelectedFolderIds = selected.length ? selected : [];
    persistReviewSelectorPrefs();
    renderFolderSelects();
    refreshReviewBucketCounts();
    showOverlay(elements.reviewFolderModal, false);
  });
}

elements.flipCard.addEventListener("click", () => {
  revealReviewAnswer();
});

elements.reviewActions.addEventListener("click", (event) => {
  const rating = event.target.dataset.rating;
  if (!rating) return;
  handleReviewRating(rating);
});

if (elements.reviewExit) {
  elements.reviewExit.addEventListener("click", exitReviewPlayer);
}

if (elements.reviewEditCard) {
  elements.reviewEditCard.disabled = true;
}

elements.importParse.addEventListener("click", handleImportPreview);

elements.importSave.addEventListener("click", handleImportSave);

if (elements.importCancel) {
  elements.importCancel.addEventListener("click", handleImportCancel);
}

if (elements.importText) {
  elements.importText.addEventListener("input", () => {
    resetImportPreview();
  });
}

elements.saveSettings.addEventListener("click", handleSaveSettings);

elements.exportJson.addEventListener("click", handleExportJson);

elements.resetLocal.addEventListener("click", handleResetLocal);

document.addEventListener(
  "pointerdown",
  (event) => {
    if (wordPopover && !wordPopover.classList.contains("hidden")) {
      if (!event.target.closest(".word-popover") && !event.target.closest(".word")) {
        closeWordPopover();
        event.stopPropagation();
        event.preventDefault();
      }
    }
  },
  { capture: true }
);

document.addEventListener("click", (event) => {
  if (event.target.closest(".item-menu")) return;
  if (event.target.closest("[data-menu-toggle]")) return;
  const tagsToggle = event.target.closest("[data-tags-toggle]");
  if (tagsToggle) {
    const panel = tagsToggle.closest(".tags-panel");
    if (panel) {
      const collapsed = panel.dataset.collapsed !== "true";
      panel.dataset.collapsed = collapsed ? "true" : "false";
      panel.classList.toggle("is-collapsed", collapsed);
      updateTagSuggestions(panel.dataset.tagsScope || "review", "");
    }
    return;
  }
  const globalDeleteTag = event.target.closest("[data-tag-delete-global]");
  if (globalDeleteTag) {
    const tag = globalDeleteTag.dataset.tagDeleteGlobal;
    deleteTagGlobally(tag);
    return;
  }
  const tagChip = event.target.closest(".tag-chip");
  if (tagChip) {
    const tag = tagChip.dataset.tag;
    const scope = tagChip.dataset.tagScope || "card";
    const selected = getTagSelectionSet(scope);
    if (selected.has(tag)) {
      selected.delete(tag);
    } else {
      selected.add(tag);
    }
    renderTagPanels();
    if (scope === "review" || scope === "review-exclude") {
      persistReviewSelectorPrefs();
      refreshReviewBucketCounts();
    }
    return;
  }
  const suggestion = event.target.closest(".tag-suggestion");
  if (suggestion) {
    const tag = suggestion.dataset.tag;
    const scope = suggestion.dataset.tagScope || "card";
    addTagsToSelection(scope, [tag]);
    const input = scope === "review"
      ? elements.reviewTags
      : scope === "review-exclude"
        ? elements.reviewTagsExclude
        : elements.cardTags;
    if (input) {
      input.value = "";
      updateTagSuggestions(scope, "");
    }
    if (scope === "review" || scope === "review-exclude") {
      persistReviewSelectorPrefs();
      refreshReviewBucketCounts();
    }
    return;
  }
  if (event.target.closest("#cards-search-clear")) {
    updateCardsSearch("");
    elements.cardsSearchInput?.focus();
    return;
  }
  if (event.target.closest("#load-more")) {
    if (!state.cardsHasMore) return;
    if (state.cardsLoadingMore) return;
    state.cardsLoadingMore = true;
    if (elements.loadMore) elements.loadMore.disabled = true;
    loadMoreCardsPage()
      .then(() => {
        if (state.cardsSearchQuery) {
          renderCardsListFiltered();
        } else {
          renderCards();
        }
      })
      .finally(() => {
        state.cardsLoadingMore = false;
        if (elements.loadMore) elements.loadMore.disabled = false;
      });
    return;
  }
  if (event.target.closest("#review-edit-card")) {
    const card = state.reviewQueue[state.currentIndex];
    if (!card) return;
    const context = getReviewCardContext(card);
    if (context.isShared && context.role !== "editor") {
      showToast("Carpeta compartida en solo lectura.", "error");
      return;
    }
    openReviewEditModal(card);
    return;
  }
  closeAllMenus();
});

window.addEventListener("resize", () => {
  if (wordPopover && !wordPopover.classList.contains("hidden")) {
    positionWordPopover();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (elements.folderModal && !elements.folderModal.classList.contains("hidden")) {
    closeFolderModal();
  }
  if (elements.cardModal && !elements.cardModal.classList.contains("hidden")) {
    closeCardModal();
  }
  if (elements.shareModal && !elements.shareModal.classList.contains("hidden")) {
    closeShareModal();
  }
  if (elements.reviewFolderModal && !elements.reviewFolderModal.classList.contains("hidden")) {
    showOverlay(elements.reviewFolderModal, false);
  }
  if (reviewEditModal && !reviewEditModal.classList.contains("hidden")) {
    closeReviewEditModal();
  }
  if (wordPopover && !wordPopover.classList.contains("hidden")) {
    closeWordPopover();
  }
});

document.addEventListener("input", (event) => {
  if (event.target === elements.cardsSearchInput) {
    updateCardsSearch(event.target.value);
  }
  if (event.target === elements.cardTags) {
    handleTagInput("card", elements.cardTags);
  }
  if (event.target === elements.reviewTags) {
    handleTagInput("review", elements.reviewTags);
    persistReviewSelectorPrefs();
    refreshReviewBucketCounts();
  }
  if (event.target === elements.reviewTagsExclude) {
    handleTagInput("review-exclude", elements.reviewTagsExclude);
    persistReviewSelectorPrefs();
    refreshReviewBucketCounts();
  }
});

document.addEventListener("keydown", (event) => {
  const isCardInput = event.target === elements.cardTags;
  const isReviewInput = event.target === elements.reviewTags;
  const isReviewExcludeInput = event.target === elements.reviewTagsExclude;
  if (!isCardInput && !isReviewInput && !isReviewExcludeInput) return;
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    const scope = isReviewInput ? "review" : isReviewExcludeInput ? "review-exclude" : "card";
    const input = isReviewInput ? elements.reviewTags : isReviewExcludeInput ? elements.reviewTagsExclude : elements.cardTags;
    handleTagInput(scope, input, true);
    if (scope === "review" || scope === "review-exclude") {
      persistReviewSelectorPrefs();
      refreshReviewBucketCounts();
    }
  }
});

window.addEventListener("popstate", () => {
  applyRoute();
});

window.addEventListener("hashchange", () => {
  applyRoute();
});

initApp();
