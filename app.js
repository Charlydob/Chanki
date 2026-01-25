import { getDb, ensureDeviceId } from "./lib/firebase.js";
import {
  listenFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  createCard,
  updateCard,
  deleteCard,
  moveCardFolder,
  fetchCardsByFolder,
  fetchCard,
  updateReview,
  buildSessionQueue,
  fetchUserData,
  userRoot,
  fetchGlossaryWord,
  upsertGlossaryEntries,
} from "./lib/rtdb.js";
import { parseImport } from "./lib/parser.js";
import { computeNextSrs } from "./lib/srs.js";
import { fetchDailyStats, calcStreak, recordReviewStats, fetchTotalsStats, fetchBucketCounts } from "./lib/stats.js";

const state = {
  username: localStorage.getItem("chanki_username") || "",
  deviceId: ensureDeviceId(),
  folders: {},
  selectedFolderId: null,
  cards: [],
  cardCursor: null,
  cardCache: new Map(),
  glossaryCache: new Map(),
  reviewQueue: [],
  currentSessionQueue: [],
  currentIndex: 0,
  sessionStats: {
    startTime: null,
    answeredCount: 0,
  },
  sessionStart: null,
  lastReviewAt: null,
  bucketCounts: {},
  reviewBuckets: {
    new: true,
    immediate: true,
    lt24h: true,
    tomorrow: true,
    week: true,
    future: true,
  },
  prefs: {
    maxNew: Number(localStorage.getItem("chanki_max_new")) || 10,
    maxReviews: Number(localStorage.getItem("chanki_max_reviews")) || 50,
    clozeCaseInsensitive: localStorage.getItem("chanki_cloze_case") !== "false",
  },
  reviewInputValue: "",
  activeWordKey: null,
  reviewFolderName: "Todas",
  reviewShowingBack: false,
  repairAttempted: false,
};

const elements = {
  status: document.getElementById("status"),
  app: document.getElementById("app"),
  screens: document.querySelectorAll(".screen"),
  tabs: document.querySelectorAll(".tab"),
  overlay: document.getElementById("overlay"),
  usernameInput: document.getElementById("username-input"),
  saveUsername: document.getElementById("save-username"),
  folderTree: document.getElementById("folder-tree"),
  addFolder: document.getElementById("add-folder"),
  cardsList: document.getElementById("cards-list"),
  addCard: document.getElementById("add-card"),
  loadMore: document.getElementById("load-more"),
  cardModal: document.getElementById("card-modal"),
  cardModalTitle: document.getElementById("card-modal-title"),
  cardType: document.getElementById("card-type"),
  cardFront: document.getElementById("card-front"),
  cardBack: document.getElementById("card-back"),
  cardClozeText: document.getElementById("card-cloze-text"),
  cardClozeAnswers: document.getElementById("card-cloze-answers"),
  cardBasicFrontField: document.getElementById("card-basic-front-field"),
  cardBasicBackField: document.getElementById("card-basic-back-field"),
  cardClozeTextField: document.getElementById("card-cloze-text-field"),
  cardClozeAnswersField: document.getElementById("card-cloze-answers-field"),
  cardTags: document.getElementById("card-tags"),
  saveCard: document.getElementById("save-card"),
  cancelCard: document.getElementById("cancel-card"),
  cardsTitle: document.getElementById("cards-title"),
  screenReviewConfig: document.getElementById("screen-review-config"),
  screenReviewPlayer: document.getElementById("screen-review-player"),
  reviewFolder: document.getElementById("review-folder"),
  reviewBucketChart: document.getElementById("review-bucket-chart"),
  reviewTags: document.getElementById("review-tags"),
  reviewMaxNew: document.getElementById("review-max-new"),
  reviewMax: document.getElementById("review-max"),
  startReview: document.getElementById("start-review"),
  reviewCard: document.getElementById("review-card"),
  flipCard: document.getElementById("flip-card"),
  reviewActions: document.getElementById("review-actions"),
  reviewExit: document.getElementById("review-exit"),
  reviewPlayerFolder: document.getElementById("review-player-folder"),
  reviewPlayerCounter: document.getElementById("review-player-counter"),
  reviewPlayerBucket: document.getElementById("review-player-bucket"),
  reviewComplete: document.getElementById("review-complete"),
  reviewCompleteSummary: document.getElementById("review-complete-summary"),
  reviewFinish: document.getElementById("review-finish"),
  importText: document.getElementById("import-text"),
  importPreview: document.getElementById("import-preview"),
  importParse: document.getElementById("import-parse"),
  importSave: document.getElementById("import-save"),
  statsTodayCount: document.getElementById("stats-today-count"),
  statsTodayMinutes: document.getElementById("stats-today-minutes"),
  statsTodayAccuracy: document.getElementById("stats-today-accuracy"),
  statsTodayDistribution: document.getElementById("stats-today-distribution"),
  statsWeekTotal: document.getElementById("stats-week-total"),
  statsWeekMinutes: document.getElementById("stats-week-minutes"),
  statsWeekAverage: document.getElementById("stats-week-average"),
  statsWeekChart: document.getElementById("stats-week-chart"),
  statsStreakCurrent: document.getElementById("stats-streak-current"),
  statsStreakBest: document.getElementById("stats-streak-best"),
  statsTotalCards: document.getElementById("stats-total-cards"),
  statsTotalNew: document.getElementById("stats-total-new"),
  statsTotalLearned: document.getElementById("stats-total-learned"),
  statsBucketCounts: document.getElementById("stats-bucket-counts"),
  settingsUsername: document.getElementById("settings-username"),
  settingsMaxNew: document.getElementById("settings-max-new"),
  settingsMax: document.getElementById("settings-max"),
  settingsClozeCase: document.getElementById("settings-cloze-case"),
  saveSettings: document.getElementById("save-settings"),
  exportJson: document.getElementById("export-json"),
  resetLocal: document.getElementById("reset-local"),
  folderModal: document.getElementById("folder-modal"),
  folderModalTitle: document.getElementById("folder-modal-title"),
  folderNameInput: document.getElementById("folder-name-input"),
  saveFolder: document.getElementById("save-folder"),
  cancelFolder: document.getElementById("cancel-folder"),
  wordModal: document.getElementById("word-modal"),
  wordTitle: document.getElementById("word-title"),
  wordMeaning: document.getElementById("word-meaning"),
  saveWord: document.getElementById("save-word"),
  cancelWord: document.getElementById("cancel-word"),
  toastContainer: document.getElementById("toast-container"),
};

const BUCKET_ORDER = ["new", "immediate", "lt24h", "tomorrow", "week", "future"];
const BUCKET_LABELS = {
  new: "Nvo",
  immediate: "Ahora",
  lt24h: "<24h",
  tomorrow: "Mañana",
  week: "<1sem",
  future: "Futuro",
};
const BUCKET_ALIASES = {
  new: "new",
  nvo: "new",
  nuevo: "new",
  immediate: "immediate",
  ahora: "immediate",
  lt24h: "lt24h",
  "<24h": "lt24h",
  "24h": "lt24h",
  tomorrow: "tomorrow",
  "mañana": "tomorrow",
  manana: "tomorrow",
  week: "week",
  "<1sem": "week",
  "1sem": "week",
  semana: "week",
  future: "future",
  futuro: "future",
};

let editingCardId = null;
let activeUnsubscribe = null;
let editingFolderId = null;

function canonicalizeBucketId(bucket) {
  if (!bucket) return null;
  const normalized = String(bucket).trim().toLowerCase();
  return BUCKET_ALIASES[normalized] || (BUCKET_ORDER.includes(normalized) ? normalized : null);
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

function setStatus(text) {
  elements.status.textContent = text;
}

function setActiveScreen(name) {
  elements.screens.forEach((screen) => {
    screen.classList.toggle("active", screen.id === `screen-${name}`);
  });
  elements.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.screen === name);
  });
  if (name !== "review") {
    setReviewMode(false);
  }
}

function closeAllMenus() {
  document.querySelectorAll(".item-menu").forEach((menu) => {
    menu.classList.add("hidden");
  });
}

function toggleMenu(menuId) {
  const menu = document.querySelector(`[data-menu-id="${menuId}"]`);
  if (!menu) return;
  const isHidden = menu.classList.contains("hidden");
  closeAllMenus();
  if (isHidden) {
    menu.classList.remove("hidden");
  }
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

function normalizeTags(text) {
  return text
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
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

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTextWithWords(text) {
  const regex = /[A-Za-zÀ-ÿÄÖÜäöüß]+(?:-[A-Za-zÀ-ÿÄÖÜäöüß]+)*/g;
  const parts = [];
  let lastIndex = 0;
  let match = regex.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "word", value: match[0] });
    lastIndex = match.index + match[0].length;
    match = regex.exec(text);
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }
  return parts
    .map((part) => {
      if (part.type === "word") {
        const safeWord = escapeHtml(part.value);
        return `<span class="word" data-word="${safeWord}">${safeWord}</span>`;
      }
      return escapeHtml(part.value).replace(/\n/g, "<br>");
    })
    .join("");
}

function normalizeWordKey(word) {
  return word.trim().toLowerCase();
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

function renderFolders() {
  const container = elements.folderTree;
  container.innerHTML = "";
  const folderList = Object.values(state.folders);
  if (!state.username) {
    container.innerHTML = "<div class=\"card\">Define tu usuario en Ajustes o al iniciar.</div>";
    return;
  }
  if (!folderList.length) {
    container.innerHTML = "<div class=\"card\">Crea tu primera carpeta para organizar tus tarjetas.</div>";
    return;
  }
  folderList.forEach((folder) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const menuId = `folder-menu-${folder.id}`;
    const subtitle = typeof folder.cardCount === "number"
      ? `${folder.cardCount} tarjetas`
      : folder.path;
    item.innerHTML = `
      <button class="item-main" data-action="select" data-id="${folder.id}" type="button">
        <span class="item-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path
              d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </svg>
        </span>
        <span class="item-text">
          <span class="item-title">${folder.name}</span>
          <span class="item-subtitle">${subtitle}</span>
        </span>
        <span class="item-chevron" aria-hidden="true">›</span>
      </button>
      <div class="item-menu-wrapper">
        <button class="icon-button" data-menu-toggle="${menuId}" type="button" aria-label="Opciones">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <div class="item-menu hidden" data-menu-id="${menuId}">
          <button data-action="rename" data-id="${folder.id}" type="button">Renombrar</button>
          <button data-action="delete" data-id="${folder.id}" type="button" class="danger">Borrar</button>
        </div>
      </div>
    `;
    container.appendChild(item);
  });
  renderFolderSelects();
}

function renderFolderSelects() {
  const select = elements.reviewFolder;
  select.innerHTML = "<option value=\"all\">Todas</option>";
  Object.values(state.folders).forEach((folder) => {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.name;
    select.appendChild(option);
  });
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

function renderCards() {
  const list = elements.cardsList;
  list.innerHTML = "";
  if (!state.cards.length) {
    list.innerHTML = "<div class=\"card\">No hay tarjetas en esta carpeta.</div>";
    return;
  }
  state.cards.forEach((card) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const summary = card.type === "cloze"
      ? `${card.clozeText || "(cloze sin texto)"}`
      : `${card.front}`;
    const detail = card.type === "cloze"
      ? `Respuestas: ${(card.clozeAnswers || []).join(", ") || "-"}`
      : `${card.back}`;
    const menuId = `card-menu-${card.id}`;
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
          <span class="item-title">${escapeHtml(summary)}</span>
          <span class="item-subtitle">${escapeHtml(detail)}</span>
        </span>
      </button>
      <div class="item-menu-wrapper">
        <button class="icon-button" data-menu-toggle="${menuId}" type="button" aria-label="Opciones">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="12" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <div class="item-menu hidden" data-menu-id="${menuId}">
          <button data-action="edit" data-id="${card.id}" type="button">Editar</button>
          <button data-action="move" data-id="${card.id}" type="button">Mover</button>
          <button data-action="delete" data-id="${card.id}" type="button" class="danger">Borrar</button>
        </div>
      </div>
    `;
    list.appendChild(item);
  });
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
  elements.cardTags.value = card ? mapToTags(card.tags).join(", ") : "";
  updateCardTypeFields(type);
  showOverlay(elements.cardModal, true);
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

async function openWordModal(word) {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    return;
  }
  const key = normalizeWordKey(word);
  state.activeWordKey = key;
  elements.wordTitle.textContent = word;
  elements.wordMeaning.value = "";
  showOverlay(elements.wordModal, true);
  if (state.glossaryCache.has(key)) {
    const cached = state.glossaryCache.get(key);
    elements.wordMeaning.value = cached.meaning || "";
    return;
  }
  try {
    const db = getDb();
    const entry = await fetchGlossaryWord(db, state.username, key);
    if (entry) {
      state.glossaryCache.set(key, entry);
      elements.wordMeaning.value = entry.meaning || "";
    }
  } catch (error) {
    console.error("Error al cargar glosario", error);
    showToast("No se pudo cargar la palabra.", "error");
  }
}

function closeWordModal() {
  showOverlay(elements.wordModal, false);
  elements.wordMeaning.value = "";
  state.activeWordKey = null;
}

async function handleSaveWord() {
  const key = state.activeWordKey;
  if (!key) return;
  const meaning = elements.wordMeaning.value.trim();
  try {
    const db = getDb();
    await upsertGlossaryEntries(db, state.username, [
      { key, word: elements.wordTitle.textContent, meaning },
    ]);
    state.glossaryCache.set(key, {
      word: elements.wordTitle.textContent,
      meaning,
    });
    showToast("Significado guardado.");
    closeWordModal();
  } catch (error) {
    console.error("Error al guardar glosario", error);
    showToast("No se pudo guardar.", "error");
  }
}

async function loadCards(reset = false) {
  if (!state.selectedFolderId) return;
  if (reset) {
    state.cards = [];
    state.cardCursor = null;
  }
  const db = getDb();
  const result = await fetchCardsByFolder(
    db,
    state.username,
    state.selectedFolderId,
    20,
    state.cardCursor
  );
  state.cards = reset ? result.cards : [...state.cards, ...result.cards];
  state.cardCursor = result.lastKey;
  renderCards();
}

function updateCardsTitle() {
  const folder = state.folders[state.selectedFolderId];
  elements.cardsTitle.textContent = folder ? `Tarjetas · ${folder.name}` : "Tarjetas";
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

function handleAddFolder() {
  if (!state.username) {
    showToast("Define tu usuario en Ajustes o al iniciar.", "error");
    return;
  }
  openFolderModal();
}

async function handleFolderAction(event) {
  const menuToggle = event.target.closest("[data-menu-toggle]");
  if (menuToggle) {
    toggleMenu(menuToggle.dataset.menuToggle);
    return;
  }
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  const folderId = actionEl.dataset.id;
  if (!action || !folderId) return;
  closeAllMenus();
  const db = getDb();
  if (action === "select") {
    state.selectedFolderId = folderId;
    updateCardsTitle();
    await loadCards(true);
  }
  if (action === "rename") {
    const folder = state.folders[folderId];
    if (folder) {
      openFolderModal(folder);
    }
  }
  if (action === "delete") {
    const confirmDelete = confirm("¿Seguro? Esto no borra tarjetas asociadas.");
    if (confirmDelete) {
      try {
        await deleteFolder(db, state.username, folderId);
        showToast("Guardado");
        if (state.selectedFolderId === folderId) {
          state.selectedFolderId = null;
          state.cards = [];
          renderCards();
        }
      } catch (error) {
        console.error("Error al borrar carpeta", error);
        showToast("Error al borrar carpeta", "error");
      }
    }
  }
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
    console.error("Error al guardar carpeta", error);
    showToast("Error al guardar carpeta", "error");
  } finally {
    elements.saveFolder.disabled = false;
  }
}

async function handleCardListAction(event) {
  const menuToggle = event.target.closest("[data-menu-toggle]");
  if (menuToggle) {
    toggleMenu(menuToggle.dataset.menuToggle);
    return;
  }
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  const cardId = actionEl.dataset.id;
  if (!action || !cardId) return;
  closeAllMenus();
  const card = state.cards.find((item) => item.id === cardId);
  if (!card) return;
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
      await moveCardFolder(db, state.username, card, newFolderId);
      await loadCards(true);
    }
  }
  if (action === "delete") {
    const confirmDelete = confirm("¿Borrar esta tarjeta?");
    if (confirmDelete) {
      const db = getDb();
      try {
        await deleteCard(db, state.username, card);
        showToast("Tarjeta borrada.");
        await loadCards(true);
        await loadStats();
      } catch (error) {
        console.error("Error al borrar tarjeta", error);
        showToast("No se pudo borrar la tarjeta.", "error");
      }
    }
  }
}

async function handleSaveCard() {
  if (!state.selectedFolderId) {
    showToast("Selecciona una carpeta primero.", "error");
    return;
  }
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
    if (!clozeText || !clozeText.includes("____")) {
      showToast("El cloze debe incluir ____ en el texto.", "error");
      return;
    }
    if (!clozeAnswers.length) {
      showToast("Añade al menos una respuesta.", "error");
      return;
    }
  }
  const tags = normalizeTags(elements.cardTags.value);
  const db = getDb();
  if (editingCardId) {
    try {
      await updateCard(db, state.username, editingCardId, {
        type,
        front,
        back,
        clozeText,
        clozeAnswers,
        tags: tagsToMap(tags),
      });
      showToast("Guardado");
    } catch (error) {
      console.error("Error al guardar tarjeta", error);
      showToast("Error al guardar tarjeta", "error");
      return;
    }
  } else {
    const id = `card_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
    try {
      await createCard(db, state.username, {
        id,
        folderId: state.selectedFolderId,
        type,
        front,
        back,
        clozeText,
        clozeAnswers,
        tags: tagsToMap(tags),
      });
      showToast("Guardado");
    } catch (error) {
      console.error("Error al crear tarjeta", error);
      showToast("Error al crear tarjeta", "error");
      return;
    }
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

function renderReviewCard(card, showBack = false) {
  elements.reviewCard.innerHTML = "";
  const wrapper = document.createElement("div");
  wrapper.className = "review-text";

  if (card.type === "cloze") {
    const frontSection = document.createElement("div");
    frontSection.className = "review-section";
    const frontLabel = document.createElement("span");
    frontLabel.className = "review-label";
    frontLabel.textContent = "Frente";
    const frontText = document.createElement("div");
    frontText.innerHTML = renderTextWithWords(card.clozeText || "");
    frontSection.appendChild(frontLabel);
    frontSection.appendChild(frontText);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cloze-input";
    input.placeholder = "Escribe la respuesta";
    input.value = state.reviewInputValue;
    input.disabled = showBack;
    frontSection.appendChild(input);
    wrapper.appendChild(frontSection);

    if (showBack) {
      const backSection = document.createElement("div");
      backSection.className = "review-section";
      const backLabel = document.createElement("span");
      backLabel.className = "review-label";
      backLabel.textContent = "Respuesta";
      const answers = document.createElement("div");
      answers.textContent = (card.clozeAnswers || []).join(", ") || "-";
      backSection.appendChild(backLabel);
      backSection.appendChild(answers);
      wrapper.appendChild(backSection);

      const correct = isClozeCorrect(card, state.reviewInputValue);
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
    frontText.innerHTML = renderTextWithWords(card.front || "");
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
      backText.innerHTML = renderTextWithWords(card.back || "");
      backSection.appendChild(backLabel);
      backSection.appendChild(backText);
      wrapper.appendChild(backSection);
    }
  }

  elements.reviewCard.appendChild(wrapper);
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
  const folderId = elements.reviewFolder.value === "all" ? null : elements.reviewFolder.value;
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
  const tagFilter = normalizeTags(elements.reviewTags.value);

  const maxNew = Number(elements.reviewMaxNew.value || state.prefs.maxNew);
  const maxReviews = Number(elements.reviewMax.value || state.prefs.maxReviews);
  const maxCards = maxNew + maxReviews;

  const bucketPriority = BUCKET_ORDER.filter((bucket) => uniqueBuckets.includes(bucket));
  const sessionResult = await buildSessionQueue({
    db,
    username: state.username,
    folderIdOrAll: folderId ?? "all",
    buckets: bucketPriority,
    maxCards,
    maxNew,
    maxReviews,
    tagFilter,
    allowRepair: !state.repairAttempted,
  });

  const { cardIds, bucketCounts, fallbackCount, usedFallback, repaired } = sessionResult;
  if (usedFallback || repaired) {
    state.repairAttempted = true;
  }

  console.debug("Review session init", {
    username: state.username,
    folderSelection: folderId ?? "all",
    activeBuckets: bucketPriority,
    queueCounts: bucketCounts,
    fallbackCards: fallbackCount,
  });

  const cards = await Promise.all(
    cardIds.map(async (cardId) => {
      if (state.cardCache.has(cardId)) {
        return state.cardCache.get(cardId);
      }
      const card = await fetchCard(db, state.username, cardId);
      if (card) state.cardCache.set(cardId, card);
      return card;
    })
  );

  const filtered = cards.filter((card) => {
    if (!card) return false;
    if (!tagFilter.length) return true;
    const cardTags = mapToTags(card.tags);
    return tagFilter.every((tag) => cardTags.includes(tag));
  });

  state.reviewQueue = filtered;
  state.currentSessionQueue = filtered.map((card) => card.id);
  state.currentIndex = 0;
}

function showNextReviewCard() {
  const total = state.reviewQueue.length;
  const card = state.reviewQueue[state.currentIndex];
  if (!card) {
    elements.reviewActions.classList.add("hidden");
    elements.flipCard.classList.add("hidden");
    elements.reviewCard.classList.add("hidden");
    if (elements.reviewComplete) {
      const durationMs = state.sessionStats.startTime
        ? Date.now() - state.sessionStats.startTime
        : 0;
      const minutes = Math.max(0, Math.round(durationMs / 60000));
      const summary = `Repasos: ${state.sessionStats.answeredCount} · Tiempo: ${minutes} min`;
      elements.reviewCompleteSummary.textContent = summary;
      elements.reviewComplete.classList.remove("hidden");
    }
    if (elements.reviewPlayerCounter) {
      const totalCount = state.reviewQueue.length;
      elements.reviewPlayerCounter.textContent = `${totalCount}/${totalCount}`;
    }
    return;
  }
  elements.reviewComplete?.classList.add("hidden");
  elements.reviewCard.classList.remove("hidden");
  elements.reviewActions.classList.add("hidden");
  elements.flipCard.classList.remove("hidden");
  state.reviewInputValue = "";
  state.reviewShowingBack = false;
  elements.flipCard.textContent = card.type === "cloze" ? "Comprobar" : "Mostrar respuesta";
  renderReviewCard(card, false);
  if (elements.reviewPlayerCounter) {
    elements.reviewPlayerCounter.textContent = `${state.currentIndex + 1}/${total}`;
  }
  if (elements.reviewPlayerBucket) {
    const bucketLabel = BUCKET_LABELS[card.srs?.bucket] || "";
    elements.reviewPlayerBucket.textContent = bucketLabel;
    elements.reviewPlayerBucket.classList.toggle("hidden", !bucketLabel);
  }
}

function revealReviewAnswer() {
  const card = state.reviewQueue[state.currentIndex];
  if (!card) return;
  const input = elements.reviewCard.querySelector(".cloze-input");
  state.reviewInputValue = input ? input.value : "";
  renderReviewCard(card, true);
  state.reviewShowingBack = true;
  elements.reviewActions.classList.remove("hidden");
  elements.flipCard.classList.add("hidden");
}

function hideReviewAnswer() {
  const card = state.reviewQueue[state.currentIndex];
  if (!card) return;
  renderReviewCard(card, false);
  state.reviewShowingBack = false;
  elements.reviewActions.classList.add("hidden");
  elements.flipCard.classList.remove("hidden");
}

function exitReviewPlayer() {
  setReviewMode(false);
  state.reviewQueue = [];
  state.currentSessionQueue = [];
  state.currentIndex = 0;
  state.reviewShowingBack = false;
  if (elements.reviewComplete) {
    elements.reviewComplete.classList.add("hidden");
  }
  if (elements.reviewCard) {
    elements.reviewCard.classList.remove("hidden");
  }
}

async function handleReviewRating(rating) {
  const card = state.reviewQueue[state.currentIndex];
  if (!card) return;
  const db = getDb();
  const nextSrs = computeNextSrs(card.srs, rating);
  try {
    await updateReview(db, state.username, card, nextSrs);
    card.srs = nextSrs;
    state.cardCache.set(card.id, card);

    const now = Date.now();
    const minutesDelta = state.lastReviewAt ? Math.max(0, Math.round((now - state.lastReviewAt) / 60000)) : 0;
    state.lastReviewAt = now;
    const tags = mapToTags(card.tags);
    await recordReviewStats(db, userRoot(state.username), {
      rating,
      folderId: card.folderId,
      tags,
      minutes: minutesDelta,
      isNew: card.srs.reps <= 1,
    });
  } catch (error) {
    console.error("Error al guardar repaso", error);
    showToast("No se pudo guardar el repaso.", "error");
    return;
  }

  state.sessionStats.answeredCount += 1;
  state.currentIndex += 1;
  showNextReviewCard();
  await loadStats();
}

async function handleImportPreview() {
  const parsed = parseImport(elements.importText.value);
  const count = parsed.cards.length;
  const clozeCount = parsed.cards.filter((card) => card.type === "cloze").length;
  const glossaryCount = parsed.glossary?.length || 0;
  elements.importPreview.textContent = `Tarjetas: ${count} (${clozeCount} cloze) · Carpeta: ${parsed.folderPath || "(sin carpeta)"} · Tags: ${parsed.tags.join(", ") || "-"} · Glosario: ${glossaryCount}`;
  elements.importPreview.dataset.parsed = JSON.stringify(parsed);
}

async function handleImportSave() {
  const parsed = elements.importPreview.dataset.parsed ? JSON.parse(elements.importPreview.dataset.parsed) : null;
  if (!parsed || !parsed.cards.length) {
    showToast("Previsualiza primero.", "error");
    return;
  }
  if (!state.username) {
    showToast("Define tu usuario antes de importar.", "error");
    return;
  }
  const db = getDb();
  let folderId = state.selectedFolderId;
  if (parsed.folderPath) {
    const folderMatch = Object.values(state.folders).find((folder) => folder.path === parsed.folderPath);
    if (folderMatch) {
      folderId = folderMatch.id;
    } else {
      const createdId = await createFolder(db, state.username, { name: parsed.folderPath });
      folderId = createdId;
    }
  }
  if (!folderId) {
    showToast("Selecciona una carpeta o define FOLDER: en el import.", "error");
    return;
  }
  for (const card of parsed.cards) {
    const id = `card_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
    await createCard(db, state.username, {
      id,
      folderId,
      type: card.type || "basic",
      front: card.front,
      back: card.back,
      clozeText: card.clozeText,
      clozeAnswers: card.clozeAnswers || [],
      tags: tagsToMap(card.tags || parsed.tags || []),
    });
  }
  if (parsed.glossary && parsed.glossary.length) {
    const entries = parsed.glossary
      .map((entry) => ({
        key: normalizeWordKey(entry.word),
        word: entry.word,
        meaning: entry.meaning,
      }))
      .filter((entry) => entry.key && entry.meaning);
    if (entries.length) {
      await upsertGlossaryEntries(db, state.username, entries);
      entries.forEach((entry) => state.glossaryCache.set(entry.key, entry));
    }
  }
  elements.importText.value = "";
  elements.importPreview.textContent = "Importación completada";
  showToast("Importación completada.");
  await loadCards(true);
}

function renderWeekChart(daily) {
  const canvas = elements.statsWeekChart;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = daily.map((day) => (day.reviews || 0) + (day.new || 0));
  const maxVal = Math.max(1, ...values);
  const padding = 16;
  const chartHeight = height - padding * 2;
  const barWidth = width / values.length;

  values.forEach((value, index) => {
    const barHeight = Math.max(6, (value / maxVal) * chartHeight);
    const x = index * barWidth + barWidth * 0.2;
    const y = height - padding - barHeight;
    const w = barWidth * 0.6;
    const radius = 6;
    ctx.fillStyle = "rgba(139, 92, 246, 0.8)";
    ctx.beginPath();
    ctx.moveTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + barHeight);
    ctx.lineTo(x, y + barHeight);
    ctx.closePath();
    ctx.fill();
  });

  ctx.fillStyle = "rgba(154, 167, 189, 0.8)";
  ctx.font = "10px SF Pro Text, system-ui, sans-serif";
  values.forEach((_, index) => {
    const label = daily[index].key.slice(6);
    const x = index * barWidth + barWidth / 2;
    ctx.fillText(label, x - 6, height - 4);
  });
}

function renderBucketCounts(bucketCounts) {
  const container = elements.statsBucketCounts;
  if (!container) return;
  container.innerHTML = "";
  const maxVal = Math.max(1, ...Object.values(bucketCounts));
  BUCKET_ORDER.forEach((bucket) => {
    const count = bucketCounts[bucket] || 0;
    const row = document.createElement("div");
    row.className = "bucket-count";
    row.innerHTML = `
      <strong>${BUCKET_LABELS[bucket]}</strong>
      <div class="bar"><span style="width: ${Math.max(8, (count / maxVal) * 100)}%"></span></div>
      <small>${count} tarjetas</small>
    `;
    container.appendChild(row);
  });
}

function renderBucketFilterCounts(bucketCounts) {
  Object.entries(BUCKET_LABELS).forEach(([bucket]) => {
    const el = document.querySelector(`[data-bucket-count="${bucket}"]`);
    if (el) {
      el.textContent = bucketCounts[bucket] || 0;
    }
  });
}

async function loadStats() {
  if (!state.username) {
    return;
  }
  const db = getDb();
  const root = userRoot(state.username);
  const [daily, totals, bucketCounts] = await Promise.all([
    fetchDailyStats(db, root, 7),
    fetchTotalsStats(db, root),
    fetchBucketCounts(db, root),
  ]);
  const today = daily[daily.length - 1] || {};
  const todayTotal = (today.reviews || 0) + (today.new || 0);
  const todayMinutes = today.minutes || 0;
  const weekTotal = daily.reduce((sum, day) => sum + (day.reviews || 0) + (day.new || 0), 0);
  const weekMinutes = daily.reduce((sum, day) => sum + (day.minutes || 0), 0);
  const accuracyBase = todayTotal || 1;
  const accuracy = Math.round((((today.good || 0) + (today.easy || 0)) / accuracyBase) * 100);

  elements.statsTodayCount.textContent = `${todayTotal} repasos`;
  elements.statsTodayMinutes.textContent = `${todayMinutes} min`;
  elements.statsTodayAccuracy.textContent = `${accuracy}%`;

  elements.statsTodayDistribution.innerHTML = "";
  ["error", "bad", "good", "easy"].forEach((rating) => {
    const chip = document.createElement("div");
    chip.className = "stats-chip";
    chip.textContent = `${rating}: ${today[rating] || 0}`;
    elements.statsTodayDistribution.appendChild(chip);
  });

  elements.statsWeekTotal.textContent = `${weekTotal} repasos`;
  elements.statsWeekMinutes.textContent = `${weekMinutes} min`;
  elements.statsWeekAverage.textContent = `${Math.round(weekTotal / 7)} /día`;

  const currentStreak = totals.currentStreak ?? calcStreak(daily);
  const bestStreak = totals.bestStreak ?? currentStreak;
  elements.statsStreakCurrent.textContent = `${currentStreak} días`;
  elements.statsStreakBest.textContent = `${bestStreak} días`;

  const totalCards = totals.totalCards || 0;
  const newCards = totals.newCards || 0;
  const learnedCards = totals.learnedCards || Math.max(0, totalCards - newCards);
  elements.statsTotalCards.textContent = totalCards;
  elements.statsTotalNew.textContent = newCards;
  elements.statsTotalLearned.textContent = learnedCards;

  state.bucketCounts = BUCKET_ORDER.reduce((acc, bucket) => {
    acc[bucket] = bucketCounts?.[bucket] || 0;
    return acc;
  }, {});
  renderBucketCounts(state.bucketCounts);
  renderBucketFilterCounts(state.bucketCounts);
  renderWeekChart(daily);
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
  initFolders();
  loadStats();
  elements.reviewMaxNew.value = state.prefs.maxNew;
  elements.reviewMax.value = state.prefs.maxReviews;
  elements.settingsUsername.value = state.username;
  elements.settingsMaxNew.value = state.prefs.maxNew;
  elements.settingsMax.value = state.prefs.maxReviews;
  elements.settingsClozeCase.checked = state.prefs.clozeCaseInsensitive;
  renderBucketFilter();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => null);
  });
}

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => setActiveScreen(tab.dataset.screen));
});

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

if (elements.wordModal) {
  elements.wordModal.addEventListener("click", (event) => {
    if (event.target === elements.wordModal) {
      closeWordModal();
    }
  });
}

elements.addCard.addEventListener("click", () => openCardModal());

elements.loadMore.addEventListener("click", () => loadCards());

elements.cardsList.addEventListener("click", handleCardListAction);

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
    if (wordEl) {
      const word = wordEl.dataset.word;
      if (word) {
        openWordModal(word);
      }
      return;
    }
    if (elements.screenReviewPlayer?.classList.contains("hidden")) return;
    if (state.reviewShowingBack) {
      hideReviewAnswer();
    } else {
      revealReviewAnswer();
    }
  });
}

elements.startReview.addEventListener("click", async () => {
  await buildReviewQueue();
  if (!state.reviewQueue.length) {
    showToast("No hay tarjetas para repasar con esos filtros.", "error");
    return;
  }
  state.sessionStart = Date.now();
  state.lastReviewAt = Date.now();
  state.sessionStats = {
    startTime: Date.now(),
    answeredCount: 0,
  };
  state.reviewFolderName = elements.reviewFolder.value === "all"
    ? "Todas"
    : state.folders[elements.reviewFolder.value]?.name || "Carpeta";
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

if (elements.reviewFinish) {
  elements.reviewFinish.addEventListener("click", exitReviewPlayer);
}

elements.importParse.addEventListener("click", handleImportPreview);

elements.importSave.addEventListener("click", handleImportSave);

elements.saveSettings.addEventListener("click", handleSaveSettings);

elements.exportJson.addEventListener("click", handleExportJson);

elements.resetLocal.addEventListener("click", handleResetLocal);

if (elements.saveWord) {
  elements.saveWord.addEventListener("click", handleSaveWord);
}

if (elements.cancelWord) {
  elements.cancelWord.addEventListener("click", closeWordModal);
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".item-menu")) return;
  if (event.target.closest("[data-menu-toggle]")) return;
  closeAllMenus();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (elements.folderModal && !elements.folderModal.classList.contains("hidden")) {
    closeFolderModal();
  }
  if (elements.wordModal && !elements.wordModal.classList.contains("hidden")) {
    closeWordModal();
  }
  if (elements.cardModal && !elements.cardModal.classList.contains("hidden")) {
    closeCardModal();
  }
});

initApp();
