import { getDb, testConnection, setDatabaseUrl, ensureDeviceId } from "./lib/firebase.js";
import {
  listenFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  createCard,
  updateCard,
  moveCardFolder,
  fetchCardsByFolder,
  fetchQueueKeys,
  fetchCard,
  updateReview,
  fetchUserData,
  userRoot,
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
  reviewQueue: [],
  reviewPointer: 0,
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
  },
};

const elements = {
  status: document.getElementById("status"),
  screens: document.querySelectorAll(".screen"),
  tabs: document.querySelectorAll(".tab"),
  overlay: document.getElementById("overlay"),
  dbOverlay: document.getElementById("db-overlay"),
  usernameInput: document.getElementById("username-input"),
  saveUsername: document.getElementById("save-username"),
  folderTree: document.getElementById("folder-tree"),
  addFolder: document.getElementById("add-folder"),
  cardsList: document.getElementById("cards-list"),
  addCard: document.getElementById("add-card"),
  loadMore: document.getElementById("load-more"),
  cardModal: document.getElementById("card-modal"),
  cardModalTitle: document.getElementById("card-modal-title"),
  cardFront: document.getElementById("card-front"),
  cardBack: document.getElementById("card-back"),
  cardTags: document.getElementById("card-tags"),
  saveCard: document.getElementById("save-card"),
  cancelCard: document.getElementById("cancel-card"),
  cardsTitle: document.getElementById("cards-title"),
  reviewFolder: document.getElementById("review-folder"),
  reviewBucketChart: document.getElementById("review-bucket-chart"),
  reviewTags: document.getElementById("review-tags"),
  reviewMaxNew: document.getElementById("review-max-new"),
  reviewMax: document.getElementById("review-max"),
  startReview: document.getElementById("start-review"),
  reviewArea: document.getElementById("review-area"),
  reviewCard: document.getElementById("review-card"),
  flipCard: document.getElementById("flip-card"),
  reviewActions: document.getElementById("review-actions"),
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
  settingsDbUrl: document.getElementById("settings-dburl"),
  settingsMaxNew: document.getElementById("settings-max-new"),
  settingsMax: document.getElementById("settings-max"),
  saveSettings: document.getElementById("save-settings"),
  testConnection: document.getElementById("test-connection"),
  exportJson: document.getElementById("export-json"),
  resetLocal: document.getElementById("reset-local"),
  dbUrlInput: document.getElementById("dburl-input"),
  saveDbUrl: document.getElementById("save-dburl"),
  folderModal: document.getElementById("folder-modal"),
  folderModalTitle: document.getElementById("folder-modal-title"),
  folderNameInput: document.getElementById("folder-name-input"),
  saveFolder: document.getElementById("save-folder"),
  cancelFolder: document.getElementById("cancel-folder"),
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

let editingCardId = null;
let activeUnsubscribe = null;
let editingFolderId = null;

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

function openFolderModal(folder = null) {
  editingFolderId = folder ? folder.id : null;
  elements.folderModalTitle.textContent = folder ? "Renombrar carpeta" : "Nueva carpeta";
  elements.saveFolder.textContent = folder ? "Guardar" : "Crear";
  elements.folderNameInput.value = folder ? folder.name : "";
  showOverlay(elements.folderModal, true);
  elements.folderNameInput.focus();
}

function closeFolderModal() {
  showOverlay(elements.folderModal, false);
  elements.folderNameInput.value = "";
}

function renderFolders() {
  const container = elements.folderTree;
  container.innerHTML = "";
  const folderList = Object.values(state.folders);
  if (!folderList.length) {
    container.innerHTML = "<div class=\"card\">Crea tu primera carpeta para organizar tus tarjetas.</div>";
    return;
  }
  folderList.forEach((folder) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <div>
        <strong>${folder.name}</strong><br />
        <small>${folder.path}</small>
      </div>
      <div class="row">
        <button class="button ghost" data-action="select" data-id="${folder.id}">Abrir</button>
        <button class="button ghost" data-action="rename" data-id="${folder.id}">Renombrar</button>
        <button class="button danger" data-action="delete" data-id="${folder.id}">Borrar</button>
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
    const bucket = bar.dataset.bucket;
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
    item.innerHTML = `
      <div>
        <strong>${card.front}</strong><br />
        <small>${card.back}</small>
      </div>
      <div class="row">
        <button class="button ghost" data-action="edit" data-id="${card.id}">Editar</button>
        <button class="button ghost" data-action="move" data-id="${card.id}">Mover</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function openCardModal(card = null) {
  editingCardId = card ? card.id : null;
  elements.cardModalTitle.textContent = card ? "Editar tarjeta" : "Nueva tarjeta";
  elements.cardFront.value = card ? card.front : "";
  elements.cardBack.value = card ? card.back : "";
  elements.cardTags.value = card ? mapToTags(card.tags).join(", ") : "";
  showOverlay(elements.cardModal, true);
}

function closeCardModal() {
  showOverlay(elements.cardModal, false);
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
  const db = getDb();
  activeUnsubscribe = listenFolders(db, state.username, (folders) => {
    state.folders = folders || {};
    renderFolders();
  });
}

function handleAddFolder() {
  openFolderModal();
}

async function handleFolderAction(event) {
  const action = event.target.dataset.action;
  const folderId = event.target.dataset.id;
  if (!action || !folderId) return;
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
  const name = elements.folderNameInput.value.trim();
  if (!name) {
    showToast("Escribe un nombre.", "error");
    return;
  }
  const db = getDb();
  try {
    if (editingFolderId) {
      await updateFolder(db, state.username, editingFolderId, { name });
    } else {
      const id = `folder_${Date.now()}`;
      const path = name;
      await createFolder(db, state.username, { id, name, path, parentId: null });
    }
    showToast("Guardado");
    closeFolderModal();
  } catch (error) {
    console.error("Error al guardar carpeta", error);
    showToast("Error al guardar carpeta", "error");
  }
}

async function handleCardListAction(event) {
  const action = event.target.dataset.action;
  const cardId = event.target.dataset.id;
  if (!action || !cardId) return;
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
}

async function handleSaveCard() {
  if (!state.selectedFolderId) {
    showToast("Selecciona una carpeta primero.", "error");
    return;
  }
  const front = elements.cardFront.value.trim();
  const back = elements.cardBack.value.trim();
  if (!front || !back) {
    showToast("Completa frente y reverso.", "error");
    return;
  }
  const tags = normalizeTags(elements.cardTags.value);
  const db = getDb();
  if (editingCardId) {
    try {
      await updateCard(db, state.username, editingCardId, {
        front,
        back,
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
        front,
        back,
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

function renderReviewCard(card, showBack = false) {
  elements.reviewCard.innerHTML = `
    <div>
      <div><strong>${showBack ? card.back : card.front}</strong></div>
      <small>${showBack ? "Reverso" : "Frente"}</small>
    </div>
  `;
}

async function buildReviewQueue() {
  const db = getDb();
  const folderId = elements.reviewFolder.value === "all" ? null : elements.reviewFolder.value;
  const enabledBuckets = Object.entries(state.reviewBuckets)
    .filter(([, active]) => active)
    .map(([bucket]) => bucket);
  if (!enabledBuckets.length) {
    showToast("Activa al menos un bucket.", "error");
    state.reviewQueue = [];
    state.reviewPointer = 0;
    return;
  }
  const tagFilter = normalizeTags(elements.reviewTags.value);

  const maxNew = Number(elements.reviewMaxNew.value || state.prefs.maxNew);
  const maxReviews = Number(elements.reviewMax.value || state.prefs.maxReviews);

  const bucketPriority = BUCKET_ORDER;
  const queue = [];

  for (const bucket of bucketPriority) {
    if (!enabledBuckets.includes(bucket)) continue;
    const limit = bucket === "new" ? maxNew : maxReviews;
    const keys = await fetchQueueKeys(db, state.username, bucket, folderId, limit);
    for (const key of keys) {
      const cardId = key.split("_").slice(1).join("_");
      queue.push({ cardId, bucket, key });
    }
  }

  const cards = await Promise.all(
    queue.map(async (entry) => {
      if (state.cardCache.has(entry.cardId)) {
        return state.cardCache.get(entry.cardId);
      }
      const card = await fetchCard(db, state.username, entry.cardId);
      if (card) state.cardCache.set(entry.cardId, card);
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
  state.reviewPointer = 0;
}

function showNextReviewCard() {
  const card = state.reviewQueue[state.reviewPointer];
  if (!card) {
    elements.reviewArea.classList.add("hidden");
    showToast("No hay tarjetas para repasar con esos filtros.", "error");
    return;
  }
  elements.reviewArea.classList.remove("hidden");
  elements.reviewActions.classList.add("hidden");
  elements.flipCard.classList.remove("hidden");
  renderReviewCard(card, false);
}

async function handleReviewRating(rating) {
  const card = state.reviewQueue[state.reviewPointer];
  if (!card) return;
  const db = getDb();
  const nextSrs = computeNextSrs(card.srs, rating);
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

  state.reviewPointer += 1;
  showNextReviewCard();
  await loadStats();
}

async function handleImportPreview() {
  const parsed = parseImport(elements.importText.value);
  const count = parsed.cards.length;
  elements.importPreview.textContent = `Tarjetas: ${count} · Carpeta: ${parsed.folderPath || "(sin carpeta)"} · Tags: ${parsed.tags.join(", ") || "-"}`;
  elements.importPreview.dataset.parsed = JSON.stringify(parsed);
}

async function handleImportSave() {
  const parsed = elements.importPreview.dataset.parsed ? JSON.parse(elements.importPreview.dataset.parsed) : null;
  if (!parsed || !parsed.cards.length) {
    showToast("Previsualiza primero.", "error");
    return;
  }
  const db = getDb();
  let folderId = state.selectedFolderId;
  if (parsed.folderPath) {
    const folderMatch = Object.values(state.folders).find((folder) => folder.path === parsed.folderPath);
    if (folderMatch) {
      folderId = folderMatch.id;
    } else {
      const id = `folder_${Date.now()}`;
      await createFolder(db, state.username, { id, name: parsed.folderPath.split("/").pop(), path: parsed.folderPath, parentId: null });
      folderId = id;
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
      front: card.front,
      back: card.back,
      tags: tagsToMap(card.tags || parsed.tags || []),
    });
  }
  elements.importText.value = "";
  elements.importPreview.textContent = "Importación completada";
  showToast("Importación completada.");
  await loadCards(true);
}

function renderWeekChart(daily) {
  const container = elements.statsWeekChart;
  if (!container) return;
  container.innerHTML = "";
  const values = daily.map((day) => (day.reviews || 0) + (day.new || 0));
  const maxVal = Math.max(1, ...values);
  daily.forEach((day, index) => {
    const bar = document.createElement("div");
    bar.className = "mini-bar";
    bar.style.height = `${Math.max(8, (values[index] / maxVal) * 70)}px`;
    const label = document.createElement("span");
    label.textContent = day.key.slice(6);
    bar.appendChild(label);
    container.appendChild(bar);
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

  state.bucketCounts = bucketCounts || {};
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
  if (newUsername && newUsername !== state.username) {
    if (confirm("Cambiar username cambia la raíz de datos.")) {
      localStorage.setItem("chanki_username", newUsername);
      location.reload();
      return;
    }
  }
  const dbUrl = elements.settingsDbUrl.value.trim();
  if (dbUrl) {
    setDatabaseUrl(dbUrl);
  }
  const maxNew = Number(elements.settingsMaxNew.value);
  const maxReviews = Number(elements.settingsMax.value);
  if (!Number.isNaN(maxNew)) {
    localStorage.setItem("chanki_max_new", String(maxNew));
  }
  if (!Number.isNaN(maxReviews)) {
    localStorage.setItem("chanki_max_reviews", String(maxReviews));
  }
  showToast("Preferencias guardadas.");
}

async function initApp() {
  if (!state.username) {
    showOverlay(elements.overlay, true);
  }

  const connected = await testConnection();
  if (!connected) {
    showOverlay(elements.dbOverlay, true);
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
  elements.settingsDbUrl.value = localStorage.getItem("chanki_database_url") || "";
  elements.settingsMaxNew.value = state.prefs.maxNew;
  elements.settingsMax.value = state.prefs.maxReviews;
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
    if (!name) return;
    localStorage.setItem("chanki_username", name);
    state.username = name;
    showOverlay(elements.overlay, false);
    initApp();
  });
}

elements.saveDbUrl.addEventListener("click", () => {
  const url = elements.dbUrlInput.value.trim();
  if (!url) return;
  setDatabaseUrl(url);
  location.reload();
});

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

elements.addCard.addEventListener("click", () => openCardModal());

elements.loadMore.addEventListener("click", () => loadCards());

elements.cardsList.addEventListener("click", handleCardListAction);

elements.saveCard.addEventListener("click", handleSaveCard);

elements.cancelCard.addEventListener("click", closeCardModal);

elements.startReview.addEventListener("click", async () => {
  await buildReviewQueue();
  state.sessionStart = Date.now();
  state.lastReviewAt = Date.now();
  showNextReviewCard();
});

if (elements.reviewBucketChart) {
  elements.reviewBucketChart.addEventListener("click", (event) => {
    const bar = event.target.closest(".bucket-bar");
    if (!bar) return;
    const bucket = bar.dataset.bucket;
    state.reviewBuckets[bucket] = !state.reviewBuckets[bucket];
    renderBucketFilter();
  });
}

elements.flipCard.addEventListener("click", () => {
  const card = state.reviewQueue[state.reviewPointer];
  if (!card) return;
  renderReviewCard(card, true);
  elements.reviewActions.classList.remove("hidden");
  elements.flipCard.classList.add("hidden");
});

elements.reviewActions.addEventListener("click", (event) => {
  const rating = event.target.dataset.rating;
  if (!rating) return;
  handleReviewRating(rating);
});

elements.importParse.addEventListener("click", handleImportPreview);

elements.importSave.addEventListener("click", handleImportSave);

elements.saveSettings.addEventListener("click", handleSaveSettings);

if (elements.testConnection) {
  elements.testConnection.addEventListener("click", async () => {
    const connected = await testConnection();
    if (connected) {
      showToast("Conexión correcta.");
    } else {
      showToast("No se pudo conectar.", "error");
    }
  });
}

elements.exportJson.addEventListener("click", handleExportJson);

elements.resetLocal.addEventListener("click", handleResetLocal);

initApp();
