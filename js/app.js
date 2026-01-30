import { getDb } from "../lib/firebase.js";
import {
  listenFolders,
  listenFolderById,
  listenSharedFoldersByUser,
  listenFolderShares,
  createFolder,
  updateFolder,
  deleteFolder,
  upsertCardWithDedupe,
  updateCard,
  deleteCard,
  moveCardFolder,
  getOrCreateFolderByPath,
  fetchCardsByFolder,
  fetchCardsByFolderId,
  fetchCardsByFolderQueue,
  fetchCardsForSearch,
  fetchCard,
  fetchFolders,
  fetchSampleCards,
  updateReview,
  buildSessionQueue,
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
  migrateCardsFolderIdsOnce,
  migrateDedupeV2Once,
  ensureVocabFolders,
  createOrUpdateVocabCard,
  listenTagsIndex,
  normalizeFolderPath,
} from "../lib/rtdb.js";
import { parseChankiImport } from "../lib/parser.js";
import { computeNextSrs } from "../lib/srs.js";
import { recordReviewStats } from "../lib/stats.js";
import {
  BUCKET_LABELS,
  BUCKET_ORDER,
  canonicalizeBucketId,
  dedupeTags,
  elements,
  getReviewFolderSelections,
  normalizeSearchQuery,
  normalizeTags,
  normalizeText,
  state,
} from "./shared.js";
import { refreshReviewBucketCounts } from "./screens/review.js";
import { loadStats } from "./screens/stats.js";
import { renderFolders, renderFolderSelects } from "./screens/folders.js";

const APP_VERSION = "0.15.0";

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
let wordPopoverAnchor = null;
let wordPopoverEditing = false;
let reviewEditModal = null;
let reviewEditCardId = null;
let reviewEditType = "basic";
let reviewEditFront = null;
let reviewEditBack = null;
let reviewEditClozeText = null;
let reviewEditClozeAnswers = null;
let reviewEditCancel = null;
let reviewEditSave = null;
let reviewEditOwnerUid = null;
let reviewEditRole = null;
let reviewEditIsShared = false;
let tagsIndexUnsubscribe = null;
let lexiconUnsubscribe = null;
let sharedFoldersUnsubscribe = null;
let sharedFolderListeners = new Map();
let folderSharesUnsubscribe = null;
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

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
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
  if (!isShared) return folder.name || folder.path || "Carpeta";
  return `${folder.name || folder.path || "Carpeta"} · ${ownerLabel}`;
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

function setActiveScreen(name) {
  const tabName = name === "cards" ? "folders" : name;
  elements.screens.forEach((screen) => {
    screen.classList.toggle("active", screen.id === `screen-${name}`);
  });
  elements.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.screen === tabName);
  });
  if (name !== "review") {
    setReviewMode(false);
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

function resolveGlossaryMeaning(word, glossaryMap) {
  const norm = normalizeWordCacheKey(word);
  if (!norm) return "";
  return glossaryMap.get(norm) || state.glossaryCache.get(norm)?.meaning || "";
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
    const meaning = resolveGlossaryMeaning(word, glossaryMap);
    if (meaning && meaning.trim()) {
      span.classList.add("gloss-term", "has-meaning");
    }
    span.dataset.word = word;
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
  renderReviewCard(card, state.reviewShowingBack);
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
  elements.folderModalTitle.textContent = folder ? "Renombrar carpeta" : "Nueva carpeta";
  elements.saveFolder.textContent = folder ? "Guardar" : "Crear";
  elements.folderNameInput.value = folder ? folder.name : "";
  elements.saveFolder.disabled = false;
  showOverlay(elements.folderModal, true);
  elements.folderNameInput.focus();
}

function closeFolderModal() {
  showOverlay(elements.folderModal, false);
  elements.folderNameInput.value = "";
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
  if (card.type === "cloze") {
    return {
      front: card.clozeText || "",
      back: (card.clozeAnswers || []).join(" | "),
    };
  }
  return {
    front: card.front || "",
    back: card.back || "",
  };
}

function buildCardListItem(card, isDuplicate, readOnly) {
  const item = document.createElement("div");
  item.className = `list-item${isDuplicate ? " is-dup" : ""}`;
  const summary = card.type === "cloze"
    ? `${card.clozeText || "(cloze sin texto)"}`
    : `${card.front}`;
  const detail = card.type === "cloze"
    ? `Respuestas: ${(card.clozeAnswers || []).join(", ") || "-"}`
    : `${card.back}`;
  item.innerHTML = `
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
  editingCardId = card ? card.id : null;
  elements.cardModalTitle.textContent = card ? "Editar tarjeta" : "Nueva tarjeta";
  const type = card?.type || "basic";
  elements.cardType.value = type;
  elements.cardFront.value = card ? card.front || "" : "";
  elements.cardBack.value = card ? card.back || "" : "";
  elements.cardClozeText.value = card ? card.clozeText || "" : "";
  elements.cardClozeAnswers.value = card ? (card.clozeAnswers || []).join(" | ") : "";
  elements.cardTags.value = "";
  state.selectedTags = new Set(mapToTags(card?.tags || {}));
  renderTagPanels();
  updateTagSuggestions("card", "");
  updateCardTypeFields(type);
  showOverlay(elements.cardModal, true);
}

function ensureReviewEditModal() {
  if (reviewEditModal) return;
  reviewEditModal = document.createElement("div");
  reviewEditModal.className = "overlay review-edit-modal hidden";
  reviewEditModal.innerHTML = `
    <div class="modal">
      <h2>Editar tarjeta</h2>
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
      <div class="row">
        <button class="button ghost" type="button" data-review-action="cancelar">Cancelar</button>
        <button class="button" type="button" data-review-action="guardar">Guardar</button>
      </div>
    </div>
  `;
  document.body.appendChild(reviewEditModal);
  const basicFrontField = reviewEditModal.querySelector("[data-review-field=\"basic-front\"]");
  const basicBackField = reviewEditModal.querySelector("[data-review-field=\"basic-back\"]");
  const clozeTextField = reviewEditModal.querySelector("[data-review-field=\"cloze-text\"]");
  const clozeAnswersField = reviewEditModal.querySelector("[data-review-field=\"cloze-answers\"]");
  reviewEditFront = basicFrontField.querySelector("textarea");
  reviewEditBack = basicBackField.querySelector("textarea");
  reviewEditClozeText = clozeTextField.querySelector("textarea");
  reviewEditClozeAnswers = clozeAnswersField.querySelector("input");
  reviewEditCancel = reviewEditModal.querySelector("[data-review-action=\"cancelar\"]");
  reviewEditSave = reviewEditModal.querySelector("[data-review-action=\"guardar\"]");

  reviewEditCancel.addEventListener("click", closeReviewEditModal);
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
  console.log("EDIT open", card.id);
  reviewEditCardId = card.id;
  const context = getReviewCardContext(card);
  reviewEditOwnerUid = context.ownerUid;
  reviewEditRole = context.role;
  reviewEditIsShared = context.isShared;
  reviewEditType = card.type || "basic";
  reviewEditFront.value = card.front || "";
  reviewEditBack.value = card.back || "";
  reviewEditClozeText.value = card.clozeText || "";
  reviewEditClozeAnswers.value = (card.clozeAnswers || []).join(" | ");
  const isCloze = reviewEditType === "cloze";
  reviewEditFront.closest(".field").classList.toggle("hidden", isCloze);
  reviewEditBack.closest(".field").classList.toggle("hidden", isCloze);
  reviewEditClozeText.closest(".field").classList.toggle("hidden", !isCloze);
  reviewEditClozeAnswers.closest(".field").classList.toggle("hidden", !isCloze);
  reviewEditModal.classList.remove("hidden");
  if (isCloze) {
    reviewEditClozeText.focus();
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
  try {
    const result = await updateCard(db, ownerUid, reviewEditCardId, {
      type: reviewEditType,
      front: nextFront,
      back: nextBack,
      clozeText: nextClozeText,
      clozeAnswers: nextClozeAnswers,
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
      });
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

function updateCardTypeFields(type) {
  const isCloze = type === "cloze";
  elements.cardBasicFrontField.classList.toggle("hidden", isCloze);
  elements.cardBasicBackField.classList.toggle("hidden", isCloze);
  elements.cardClozeTextField.classList.toggle("hidden", !isCloze);
  elements.cardClozeAnswersField.classList.toggle("hidden", !isCloze);
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
      <input type="text" class="word-popover__input" />
      <button class="button small" type="button">Guardar</button>
    </div>
  `;
  document.body.appendChild(wordPopover);
  wordPopoverTitle = wordPopover.querySelector(".word-popover__title");
  wordPopoverMeaning = wordPopover.querySelector(".word-popover__meaning .meaning");
  wordPopoverEditor = wordPopover.querySelector(".word-popover__editor");
  wordPopoverInput = wordPopover.querySelector(".word-popover__input");
  wordPopoverSave = wordPopover.querySelector(".word-popover__editor .button");

  wordPopover.querySelector(".word-popover__meaning").addEventListener("click", () => {
    if (!wordPopover || wordPopover.classList.contains("hidden")) return;
    wordPopoverEditing = true;
    wordPopoverEditor.classList.remove("hidden");
    wordPopoverInput.value = wordPopoverMeaning.textContent === "Añade significado…"
      ? ""
      : wordPopoverMeaning.textContent;
    wordPopoverInput.focus();
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
      await upsertGlossaryEntries(db, state.username, [
        {
          key,
          word: wordPopoverTitle.textContent,
          meaning,
          tags: tagsToMap(tags),
        },
      ]);
      if (termKey) {
        await upsertLexiconEntry(db, state.username, termKey, meaning);
        state.lexicon = {
          ...state.lexicon,
          [termKey]: {
            meaning,
            updatedAt: Date.now(),
          },
        };
      }
      if (norm) {
        state.glossaryCache.set(norm, {
          key,
          word: wordPopoverTitle.textContent,
          meaning,
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
      if (cleanedMeaning) {
        const folderIds = await ensureVocabFolderIds();
        const direction = state.activeWordContext?.language === "es" ? "es-de" : "de-es";
        const folderId = direction === "es-de" ? folderIds?.esDe : folderIds?.deEs;
        if (folderId) {
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
  const folder = activeRef?.isShared ? getActiveFolderInfo() : state.folders[folderId];
  const folderPath = folder?.path || folder?.name || "";
  console.log("selectedFolderId", folderId, "selectedFolderPath", folderPath, "username", ownerUid);
  try {
    const db = getDb();
    const [sampleCards, folders] = await Promise.all([
      fetchSampleCards(db, ownerUid, 5),
      fetchFolders(db, ownerUid),
    ]);
    sampleCards.forEach((card) => {
      console.log(
        "sampleCard",
        "cardId",
        card.id,
        "folderId",
        card.folderId,
        "folderPath",
        card.folderPath,
        "front",
        card.front
      );
    });
    const folderEntries = Object.values(folders || {}).map((entry) => ({
      id: entry.id,
      path: entry.path,
    }));
    console.log("foldersSnapshot", folderEntries);
  } catch (error) {
    handleErrorToast(error, "No se pudo cargar el diagnóstico.");
  }
}

async function runFolderIdMigration() {
  if (!state.username) return;
  if (localStorage.getItem("chanki_migrated_folderIds") === "1") return;
  try {
    const db = getDb();
    const result = await migrateCardsFolderIdsOnce(db, state.username, 2000);
    console.log("MIGRATE folderIds", result);
    localStorage.setItem("chanki_migrated_folderIds", "1");
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
    return;
  }
  if (activeRef.isShared) {
    const ownerLabel = getUserLabel(activeRef.ownerUid);
    elements.cardsTitle.textContent = `Tarjetas · ${folder.name} (Compartida por ${ownerLabel})`;
    return;
  }
  elements.cardsTitle.textContent = `Tarjetas · ${folder.name}`;
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

function findFolderIdByPath(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return null;
  return Object.values(state.folders || {}).find((folder) =>
    normalizeFolderPath(folder.path || folder.name) === normalized
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
  activeUnsubscribe = listenFolders(db, state.username, (folders) => {
    state.folders = folders || {};
    renderFolders();
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
          path: folder?.path || "",
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
  if (!action || !folderId) return;
  closeAllMenus();
  if (action === "select") {
    const ownerUid = actionEl.dataset.ownerUid || state.username;
    const isShared = actionEl.dataset.shared === "true";
    const role = actionEl.dataset.role || (isShared ? "viewer" : "owner");
    state.selectedFolderId = folderId;
    state.activeFolderRef = {
      ownerUid,
      folderId,
      role,
      isShared,
    };
    state.cardsSearchPool = [];
    state.cardsSearchFolderId = null;
    state.cardsSearchOwnerUid = null;
    updateCardsTitle();
    updateSearchUI();
    debugFolderSelection(folderId);
    await loadCards(true);
    if (state.cardsSearchQuery) {
      loadSearchPool();
    }
    updateFolderAccessUI();
    setActiveScreen("cards");
  }
  if (action === "rename" || action === "delete" || action === "share") {
    handleFolderMenuAction(action, folderId);
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

async function handleSaveFolder() {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    return;
  }
  const name = elements.folderNameInput.value.trim();
  if (!name) {
    showToast("Escribe un nombre.", "error");
    return;
  }
  const db = getDb();
  elements.saveFolder.disabled = true;
  try {
    if (editingFolderId) {
      await updateFolder(db, state.username, editingFolderId, { name });
    } else {
      await createFolder(db, state.username, { name });
    }
    showToast("Guardado");
    closeFolderModal();
  } catch (error) {
    handleErrorToast(error, "Error al guardar carpeta.");
  } finally {
    elements.saveFolder.disabled = false;
  }
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
  if (action === "edit") {
    openCardModal(card);
  }
  if (action === "move") {
    const folderOptions = Object.values(state.folders)
      .map((folder) => `${folder.id}:${folder.name}`)
      .join("\n");
    const newFolderId = prompt(`Mover a carpeta (id:nombre)\n${folderOptions}`);
    if (newFolderId && state.folders[newFolderId]) {
      const db = getDb();
      await moveCardFolder(db, ownerUid, card, newFolderId);
      await loadCards(true);
    }
  }
  if (action === "delete") {
    const confirmDelete = confirm("¿Borrar esta tarjeta?");
    if (confirmDelete) {
      const db = getDb();
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
  if (!state.selectedFolderId) {
    showToast("Selecciona una carpeta primero.", "error");
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
  const clozeText = elements.cardClozeText.value.trim();
  const clozeAnswers = elements.cardClozeAnswers.value
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
        clozeText,
        clozeAnswers,
        tags: tagsToMap(finalTags),
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
        folderId: state.selectedFolderId,
        type,
        front,
        back,
        clozeText,
        clozeAnswers,
        tags: tagsToMap(finalTags),
      });
      if (result.status === "duplicate") {
        showToast("Duplicado omitido.");
      } else if (result.status === "updated") {
        showToast("Tarjeta actualizada.");
      } else {
        showToast("Guardado");
      }
    } catch (error) {
      handleErrorToast(error, "Error al crear tarjeta.");
      return;
    }
  }
  closeCardModal();
  elements.cardTags.value = "";
  state.selectedTags = new Set();
  renderTagPanels();
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

function renderReviewCard(card, showBack = false) {
  elements.reviewCard.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = showBack ? "review-text review-text--reveal" : "review-text";
  const glossaryMap = buildGlossaryMap(card);

  if (card.type === "cloze") {
    const frontSection = document.createElement("div");
    frontSection.className = "review-section";
    const frontLabel = document.createElement("span");
    frontLabel.className = "review-label";
    frontLabel.textContent = "Frente";
    const frontText = document.createElement("div");
    const clozeTokens = tokenizeClozeText(card.clozeText || "");
    const blankCount = clozeTokens.filter((token) => token.type === "blank").length;
    frontText.className = blankCount ? "review-front review-front--cloze" : "review-front";
    const answers = blankCount
      ? state.reviewClozeAnswers.length === blankCount
        ? [...state.reviewClozeAnswers]
        : Array.from({ length: blankCount }, () => "")
      : [state.reviewClozeAnswers[0] || ""];
    state.reviewClozeAnswers = answers;
    const inlineInputs = [];
    const evaluation = showBack ? evaluateClozeAnswers(card, answers, blankCount) : null;
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
      frontText.appendChild(renderTextWithLanguage(card.clozeText || "", "de", glossaryMap));
    }
    frontSection.appendChild(frontLabel);
    frontSection.appendChild(frontText);
    wrapper.appendChild(frontSection);

    if (showBack) {
      const backSection = document.createElement("div");
      backSection.className = "review-section";
      const backLabel = document.createElement("span");
      backLabel.className = "review-label";
      backLabel.textContent = "Respuesta";
      const answers = document.createElement("div");
      answers.className = "review-back";
      answers.textContent = formatCardText((card.clozeAnswers || []).join(" | ")) || "-";
      backSection.appendChild(backLabel);
      backSection.appendChild(answers);
      wrapper.appendChild(backSection);

      const correct = blankCount
        ? evaluation?.correct
        : isClozeCorrect(card, answers[0] || "");
      const feedback = document.createElement("div");
      feedback.className = "review-feedback";
      feedback.textContent = correct ? "Respuesta correcta." : "Respuesta incorrecta.";
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
    frontText.appendChild(renderTextWithLanguage(card.front || "", "de", glossaryMap));
    frontSection.appendChild(frontLabel);
    frontSection.appendChild(frontText);
    wrapper.appendChild(frontSection);

    if (showBack) {
      const backSection = document.createElement("div");
      backSection.className = "review-section";
      const backLabel = document.createElement("span");
      backLabel.className = "review-label";
      backLabel.textContent = "Reverso";
      const backText = document.createElement("div");
      backText.className = "review-back";
      backText.appendChild(renderBackWithLanguage(card.back || "", glossaryMap));
      backSection.appendChild(backLabel);
      backSection.appendChild(backText);
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
  const db = getDb();
  const selections = getReviewFolderSelections();
  const primarySelection = selections.length === 1 ? selections[0] : null;
  state.reviewFolderOwnerUid = primarySelection?.ownerUid || null;
  state.reviewFolderRole = primarySelection?.role || null;
  state.reviewFolderIsShared = Boolean(primarySelection?.isShared);
  const enabledBuckets = Object.entries(state.reviewBuckets)
    .filter(([, active]) => active)
    .map(([bucket]) => canonicalizeBucketId(bucket))
    .filter(Boolean);
  const uniqueBuckets = [...new Set(enabledBuckets)];
  if (!uniqueBuckets.length) {
    showToast("Activa al menos un bucket.", "error");
    state.reviewQueue = [];
    state.currentSessionQueue = [];
    state.currentIndex = 0;
    return;
  }
  const tagFilter = dedupeTags([
    ...state.reviewSelectedTags,
    ...normalizeTags(elements.reviewTags.value),
  ]);

  const maxNew = Number(elements.reviewMaxNew.value || state.prefs.maxNew);
  const maxReviews = Number(elements.reviewMax.value || state.prefs.maxReviews);
  const maxCards = maxNew + maxReviews;

  const bucketPriority = BUCKET_ORDER.filter((bucket) => uniqueBuckets.includes(bucket));
  const combinedCardIds = [];
  const combinedBucketCounts = BUCKET_ORDER.reduce((acc, bucket) => {
    acc[bucket] = 0;
    return acc;
  }, {});
  const cardMeta = new Map();
  let usedFallback = false;
  let repaired = false;
  let fallbackCount = 0;

  for (const selection of selections) {
    const sessionResult = await buildSessionQueue({
      db,
      username: selection.ownerUid,
      folderIdOrAll: selection.folderId ?? "all",
      buckets: bucketPriority,
      maxCards,
      maxNew,
      maxReviews,
      tagFilter,
      tagFilterMode: "or",
      allowRepair: !state.repairAttempted,
    });

    BUCKET_ORDER.forEach((bucket) => {
      combinedBucketCounts[bucket] += sessionResult.bucketCounts?.[bucket] || 0;
    });
    fallbackCount += sessionResult.fallbackCount || 0;
    usedFallback = usedFallback || sessionResult.usedFallback;
    repaired = repaired || sessionResult.repaired;

    sessionResult.cardIds.forEach((cardId) => {
      if (cardMeta.has(cardId)) return;
      cardMeta.set(cardId, {
        ownerUid: selection.ownerUid,
        role: selection.role,
        isShared: selection.isShared,
        shareKey: selection.shareKey,
      });
      combinedCardIds.push(cardId);
    });
  }

  if (usedFallback || repaired) {
    state.repairAttempted = true;
  }

  console.debug("Review session init", {
    selections,
    activeBuckets: bucketPriority,
    queueCounts: combinedBucketCounts,
    fallbackCards: fallbackCount,
  });

  const cards = await Promise.all(
    combinedCardIds.map(async (cardId) => {
      if (state.cardCache.has(cardId)) {
        const cached = state.cardCache.get(cardId);
        return { ...cached };
      }
      const meta = cardMeta.get(cardId);
      const card = await fetchCard(db, meta?.ownerUid || state.username, cardId);
      if (card) state.cardCache.set(cardId, card);
      return card;
    })
  );

  const filtered = cards.filter((card) => {
    if (!card) return false;
    return cardMatchesTagFilter(card, tagFilter, "or");
  });

  const bucketed = new Map();
  filtered.forEach((card) => {
    const bucketId = canonicalizeBucketId(card.srs?.bucket) || "new";
    if (!bucketed.has(bucketId)) {
      bucketed.set(bucketId, []);
    }
    bucketed.get(bucketId).push(card);
  });

  const orderedBuckets = bucketPriority.length ? bucketPriority : BUCKET_ORDER;
  const ordered = [];
  orderedBuckets.forEach((bucket) => {
    const bucketCards = bucketed.get(bucket);
    if (bucketCards?.length) {
      ordered.push(...shuffle(bucketCards));
    }
  });
  bucketed.forEach((bucketCards, bucket) => {
    if (orderedBuckets.includes(bucket)) return;
    ordered.push(...shuffle(bucketCards));
  });

  const limited = ordered.slice(0, maxCards);
  limited.forEach((card) => {
    const meta = cardMeta.get(card.id);
    if (!meta) return;
    card._reviewOwnerUid = meta.ownerUid;
    card._reviewRole = meta.role;
    card._reviewIsShared = meta.isShared;
    card._reviewShareKey = meta.shareKey;
  });
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
  state.reviewShowingBack = false;
  elements.flipCard.textContent = card.type === "cloze" ? "Comprobar" : "Mostrar respuesta";
  renderReviewCard(card, false);
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
  renderReviewCard(card, true);
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
  const summary = {
    created: 0,
    updated: 0,
    duplicates: 0,
    createdFolders: 0,
    processedCards: 0,
  };
  const resolvedFolders = new Map();
  for (const block of blocks) {
    const folderPath = options.forcedFolderId
      ? null
      : resolveBlockFolderPath(block, folderFallback);
    let folderId = options.forcedFolderId || null;
    if (!folderId) {
      if (activeRef?.isShared) {
        throw new Error("No puedes crear carpetas en una compartida.");
      }
      const normalizedPath = normalizeFolderPath(folderPath);
      if (resolvedFolders.has(normalizedPath)) {
        folderId = resolvedFolders.get(normalizedPath);
      } else {
        const existingId = findFolderIdByPath(normalizedPath);
        folderId = await getOrCreateFolderByPath(db, ownerUid, normalizedPath, state.folders);
        resolvedFolders.set(normalizedPath, folderId);
        if (!existingId) {
          summary.createdFolders += 1;
        }
      }
    }
    if (!folderId) continue;
    for (const card of block.cards) {
      const id = `card_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
      const result = await upsertCardWithDedupe(db, ownerUid, {
        id,
        folderId,
        type: card.type || "basic",
        front: card.front,
        back: card.back,
        clozeText: card.clozeText,
        clozeAnswers: card.clozeAnswers || [],
        tags: tagsToMap(card.tags || block.tags || []),
      });
      summary.processedCards += 1;
      if (result.status === "created") {
        summary.created += 1;
      } else if (result.status === "updated") {
        summary.updated += 1;
      } else {
        summary.duplicates += 1;
      }
    }
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
  const forcedFolderId = importState.mode === "folder" ? importState.forcedFolderId : null;
  if (importState.mode === "folder" && !forcedFolderId) {
    showToast("Selecciona una carpeta antes de importar aquí.", "error");
    return;
  }
  window.__importing = true;
  elements.importSave.disabled = true;
  console.log("IMPORT START", { parsed: totalCards, forcedFolderId });
  try {
    const summary = await importBlocks(parsed.blocks, {
      forcedFolderId,
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
  localStorage.setItem("chanki_cloze_case", clozeCase ? "true" : "false");
  state.prefs.clozeCaseInsensitive = clozeCase;
  elements.reviewMaxNew.value = state.prefs.maxNew;
  elements.reviewMax.value = state.prefs.maxReviews;
  showToast("Preferencias guardadas.");
}

function ensureTagPanels() {
  if (elements.cardTags?.dataset.tagsReady) return;
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

  const reviewField = elements.reviewTags?.closest(".field");
  if (reviewField && !reviewField.dataset.tagsReady) {
    const panel = document.createElement("div");
    panel.className = "tags-panel tags-panel--collapsible is-collapsed";
    panel.dataset.tagsScope = "review";
    panel.dataset.collapsed = "true";
    panel.innerHTML = `
      <button type="button" class="tags-panel__toggle" data-tags-toggle>
        <span>Tags existentes / seleccionados</span>
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
    reviewField.insertAdjacentElement("afterend", panel);
    reviewField.dataset.tagsReady = "true";
  }
}

function renderTagPanels() {
  ensureTagPanels();
  document.querySelectorAll(".tags-panel").forEach((panel) => {
    const scope = panel.dataset.tagsScope;
    const selected = scope === "review" ? state.reviewSelectedTags : state.selectedTags;
    const selectedContainer = panel.querySelector("[data-tags-selected]");
    const allContainer = panel.querySelector("[data-tags-all]");
    if (!selectedContainer || !allContainer) return;
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
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = selected.has(tag) ? "tag-chip tag-chip--selected" : "tag-chip";
      chip.dataset.tag = tag;
      chip.dataset.tagScope = scope;
      chip.textContent = tag;
      allContainer.appendChild(chip);
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
  const selected = scope === "review" ? state.reviewSelectedTags : state.selectedTags;
  if (!trimmed) {
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
  const selected = scope === "review" ? state.reviewSelectedTags : state.selectedTags;
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

async function initApp() {
  if (!state.username) {
    showOverlay(elements.overlay, true);
    setStatus("Define un usuario para empezar.");
    return;
  }

  initFirebaseUi();
}

function initFirebaseUi() {
  getDb();
  setStatus(`Usuario: ${state.username}`);
  syncUsersPublic();
  initFolders();
  initSharedFolders();
  state.activeFolderRef = null;
  runFolderIdMigration();
  runDedupeMigration();
  loadStats();
  updateSearchUI();
  initLexiconListener();
  initTagsIndexListener();
  ensureTagPanels();
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
  renderBucketFilter();
  refreshReviewBucketCounts();
  setImportContext("generic", { sourceScreen: "import" });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => null);
  });
}

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.screen === "import") {
      setImportContext("generic", { sourceScreen: "import" });
      resetImportPreview();
    }
    setActiveScreen(tab.dataset.screen);
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

elements.folderTree.addEventListener("click", handleFolderAction);

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

elements.saveCard.addEventListener("click", handleSaveCard);

elements.cancelCard.addEventListener("click", closeCardModal);

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
    showToast("No hay tarjetas para repasar con esos filtros.", "error");
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

if (elements.reviewFolderTrigger) {
  elements.reviewFolderTrigger.addEventListener("click", () => {
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

if (elements.reviewFolderOptions) {
  elements.reviewFolderOptions.addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[type=\"checkbox\"]");
    if (!checkbox) return;
    if (checkbox.value === "all" && checkbox.checked) {
      elements.reviewFolderOptions
        .querySelectorAll("input[type=\"checkbox\"]:not([value=\"all\"])")
        .forEach((input) => {
          input.checked = false;
        });
    }
    if (checkbox.value !== "all" && checkbox.checked) {
      const allBox = elements.reviewFolderOptions.querySelector("input[value=\"all\"]");
      if (allBox) allBox.checked = false;
    }
  });
}

if (elements.reviewFolderApply) {
  elements.reviewFolderApply.addEventListener("click", () => {
    if (!elements.reviewFolderOptions) return;
    const checked = Array.from(
      elements.reviewFolderOptions.querySelectorAll("input[type=\"checkbox\"]:checked")
    ).map((input) => input.value);
    const selected = checked.filter((value) => value !== "all");
    state.reviewSelectedFolderIds = selected.length ? selected : [];
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
  const tagChip = event.target.closest(".tag-chip");
  if (tagChip) {
    const tag = tagChip.dataset.tag;
    const scope = tagChip.dataset.tagScope || "card";
    const selected = scope === "review" ? state.reviewSelectedTags : state.selectedTags;
    if (selected.has(tag)) {
      selected.delete(tag);
    } else {
      selected.add(tag);
    }
    renderTagPanels();
    if (scope === "review") {
      refreshReviewBucketCounts();
    }
    return;
  }
  const suggestion = event.target.closest(".tag-suggestion");
  if (suggestion) {
    const tag = suggestion.dataset.tag;
    const scope = suggestion.dataset.tagScope || "card";
    addTagsToSelection(scope, [tag]);
    const input = scope === "review" ? elements.reviewTags : elements.cardTags;
    if (input) {
      input.value = "";
      updateTagSuggestions(scope, "");
    }
    if (scope === "review") {
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
    refreshReviewBucketCounts();
  }
});

document.addEventListener("keydown", (event) => {
  const isCardInput = event.target === elements.cardTags;
  const isReviewInput = event.target === elements.reviewTags;
  if (!isCardInput && !isReviewInput) return;
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    const scope = isReviewInput ? "review" : "card";
    const input = isReviewInput ? elements.reviewTags : elements.cardTags;
    handleTagInput(scope, input, true);
    if (scope === "review") {
      refreshReviewBucketCounts();
    }
  }
});

initApp();
