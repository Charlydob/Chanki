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
import { fetchDailyStats, calcStreak, recordReviewStats } from "./lib/stats.js";

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
  statsToday: document.getElementById("stats-today"),
  statsWeek: document.getElementById("stats-week"),
  statsStreak: document.getElementById("stats-streak"),
  statsChart: document.getElementById("stats-chart"),
  settingsUsername: document.getElementById("settings-username"),
  settingsDbUrl: document.getElementById("settings-dburl"),
  settingsMaxNew: document.getElementById("settings-max-new"),
  settingsMax: document.getElementById("settings-max"),
  saveSettings: document.getElementById("save-settings"),
  exportJson: document.getElementById("export-json"),
  resetLocal: document.getElementById("reset-local"),
  dbUrlInput: document.getElementById("dburl-input"),
  saveDbUrl: document.getElementById("save-dburl"),
};

let editingCardId = null;
let activeUnsubscribe = null;

function showOverlay(overlay, show) {
  overlay.classList.toggle("hidden", !show);
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

function renderFolders() {
  const container = elements.folderTree;
  container.innerHTML = "";
  const folderList = Object.values(state.folders);
  if (!folderList.length) {
    container.innerHTML = "<div class=\"card\">Crea tu primera carpeta.</div>";
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

async function handleAddFolder() {
  const name = prompt("Nombre de la carpeta");
  if (!name) return;
  const id = `folder_${Date.now()}`;
  const path = name;
  const db = getDb();
  await createFolder(db, state.username, { id, name, path, parentId: null });
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
    const name = prompt("Nuevo nombre");
    if (name) {
      await updateFolder(db, state.username, folderId, { name });
    }
  }
  if (action === "delete") {
    const confirmDelete = confirm("¿Seguro? Esto no borra tarjetas asociadas.");
    if (confirmDelete) {
      await deleteFolder(db, state.username, folderId);
      if (state.selectedFolderId === folderId) {
        state.selectedFolderId = null;
        state.cards = [];
        renderCards();
      }
    }
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
    alert("Selecciona una carpeta primero");
    return;
  }
  const front = elements.cardFront.value.trim();
  const back = elements.cardBack.value.trim();
  if (!front || !back) {
    alert("Completa frente y reverso");
    return;
  }
  const tags = normalizeTags(elements.cardTags.value);
  const db = getDb();
  if (editingCardId) {
    await updateCard(db, state.username, editingCardId, {
      front,
      back,
      tags: tagsToMap(tags),
    });
  } else {
    const id = `card_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
    await createCard(db, state.username, {
      id,
      folderId: state.selectedFolderId,
      front,
      back,
      tags: tagsToMap(tags),
    });
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
  const enabledBuckets = Array.from(document.querySelectorAll("[data-bucket]"))
    .filter((input) => input.checked)
    .map((input) => input.dataset.bucket);
  const tagFilter = normalizeTags(elements.reviewTags.value);

  const maxNew = Number(elements.reviewMaxNew.value || state.prefs.maxNew);
  const maxReviews = Number(elements.reviewMax.value || state.prefs.maxReviews);

  const bucketPriority = ["immediate", "lt24h", "tomorrow", "week", "future", "new"];
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
    alert("No hay tarjetas para repasar con esos filtros.");
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
    alert("Previsualiza primero");
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
    alert("Selecciona una carpeta o define FOLDER: en el import");
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
  await loadCards(true);
}

function drawStatsChart(data) {
  const canvas = elements.statsChart;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const padding = 20;
  const width = canvas.width - padding * 2;
  const height = canvas.height - padding * 2;
  const values = data.map((day) => (day.reviews || 0) + (day.new || 0));
  const maxVal = Math.max(1, ...values);

  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, padding + height);
  ctx.lineTo(padding + width, padding + height);
  ctx.stroke();

  ctx.strokeStyle = "#5eead4";
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = padding + (width / (values.length - 1 || 1)) * index;
    const y = padding + height - (value / maxVal) * height;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

async function loadStats() {
  const db = getDb();
  const daily = await fetchDailyStats(db, userRoot(state.username), 7);
  const today = daily[daily.length - 1] || {};
  const weekTotal = daily.reduce((sum, day) => sum + (day.reviews || 0) + (day.new || 0), 0);
  elements.statsToday.textContent = `${(today.reviews || 0) + (today.new || 0)} repasos`;
  elements.statsWeek.textContent = `${weekTotal} repasos`;
  elements.statsStreak.textContent = `${calcStreak(daily)} días`;
  drawStatsChart(daily);
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
  alert("Preferencias guardadas. Recarga si cambiaste la URL.");
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

elements.exportJson.addEventListener("click", handleExportJson);

elements.resetLocal.addEventListener("click", handleResetLocal);

initApp();
