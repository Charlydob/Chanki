import { elements, normalizeSearchQuery, state } from "../shared.js";
import { refreshReviewBucketCounts } from "./review.js";

const DEFAULT_EMOJI = "📁";

function ownedFolders() {
  return Object.entries(state.folders || {}).map(([id, folder]) => ({
    ...folder,
    id,
    name: folder?.name || "Carpeta",
    emoji: folder?.emoji || DEFAULT_EMOJI,
    color: folder?.color || "#8b5cf6",
    _search: normalizeSearchQuery(folder?.name || ""),
  }));
}

function sharedFolders() {
  return Object.entries(state.sharedFolders || {}).map(([shareKey, folder]) => ({
    ...folder,
    shareKey,
    folderId: folder?.folderId,
    name: folder?.name || "Carpeta compartida",
    emoji: folder?.emoji || DEFAULT_EMOJI,
    color: folder?.color || "#8b5cf6",
    _search: normalizeSearchQuery(folder?.name || ""),
  })).filter((folder) => folder.folderId);
}

function folderCardMarkup(folder, subtitle, extraAttrs = "") {
  return `
    <button class="folder-card" type="button" data-action="select" data-id="${folder.id || folder.folderId}" ${extraAttrs}
      style="--folder-accent:${folder.color};">
      <span class="folder-card__emoji">${folder.emoji}</span>
      <span class="folder-card__text">
        <span class="folder-card__name">${folder.name}</span>
        <span class="folder-card__count">${subtitle}</span>
      </span>
    </button>
  `;
}

export function getVisibleReviewFolderOptionIds() {
  if (!elements.reviewFolderOptions) return [];
  return Array.from(elements.reviewFolderOptions.querySelectorAll("[data-folder-id]"))
    .map((el) => el.dataset.folderId)
    .filter(Boolean);
}

export function renderFolderSelects() {
  const options = elements.reviewFolderOptions;
  if (!options) return;
  const query = normalizeSearchQuery(state.reviewFolderSearchQuery || "");
  const list = ownedFolders().filter((folder) => !query || folder._search.includes(query));
  const selected = new Set(state.reviewSelectedFolderIds || []);

  options.innerHTML = "";
  if (!list.length) {
    options.innerHTML = '<div class="card">Sin carpetas para ese filtro.</div>';
  } else {
    list.forEach((folder) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `review-folder-chip${selected.has(folder.id) ? " is-selected" : ""}`;
      button.dataset.folderId = folder.id;
      button.style.setProperty("--folder-accent", folder.color);
      button.innerHTML = `<span>${folder.emoji}</span><span>${folder.name}</span>`;
      options.appendChild(button);
    });
  }

  if (elements.reviewFolderLabel) {
    if (!selected.size) elements.reviewFolderLabel.textContent = "Todas";
    else if (selected.size === 1) {
      const id = [...selected][0];
      elements.reviewFolderLabel.textContent = state.folders[id]?.name || "Carpeta";
    } else {
      elements.reviewFolderLabel.textContent = `${selected.size} carpetas`;
    }
  }
  refreshReviewBucketCounts();
}

export function renderFolders() {
  const container = elements.folderTree;
  if (!container) return;
  container.innerHTML = "";

  const own = ownedFolders();
  const shared = sharedFolders();
  if (!state.username) {
    container.innerHTML = '<div class="card">Define tu usuario en Ajustes o al iniciar.</div>';
    return;
  }
  if (!own.length && !shared.length) {
    container.innerHTML = '<div class="card">Crea tu primera carpeta para organizar tus tarjetas.</div>';
    return;
  }

  const grid = document.createElement("div");
  grid.className = "folder-grid";

  own.forEach((folder) => {
    const item = document.createElement("div");
    item.className = "folder-grid-item";
    item.innerHTML = `
      ${folderCardMarkup(folder, `${folder.cardCount || 0} tarjetas`, `data-owner-uid="${state.username}"`)}
      <div class="folder-card-actions">
        <button class="icon-button icon-button--compact" data-action="rename" data-id="${folder.id}" type="button">✏️</button>
        <button class="icon-button icon-button--compact icon-button--danger" data-action="delete" data-id="${folder.id}" type="button">🗑️</button>
      </div>`;
    grid.appendChild(item);
  });

  shared.forEach((folder) => {
    const item = document.createElement("div");
    item.className = "folder-grid-item";
    item.innerHTML = folderCardMarkup(
      { ...folder, id: folder.folderId },
      `${folder.cardCount || 0} tarjetas · compartida`,
      `data-owner-uid="${folder.ownerUid}" data-shared="true"`
    );
    grid.appendChild(item);
  });

  container.appendChild(grid);
  renderFolderSelects();
}
