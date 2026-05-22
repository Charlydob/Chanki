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

function folderRowMarkup(folder, subtitle, extraAttrs = "", actions = "") {
  return `
    <article class="folder-row" style="--folder-accent:${folder.color};" draggable="true" data-folder-id="${folder.id || folder.folderId}">
      <button class="folder-row__main" type="button" data-action="select" data-id="${folder.id || folder.folderId}" ${extraAttrs}>
        <span class="folder-row__emoji">${folder.emoji}</span>
        <span class="folder-row__text">
          <span class="folder-row__name">${folder.name}</span>
          <span class="folder-row__count">${subtitle}</span>
        </span>
      </button>
      ${actions ? `<div class="folder-row__actions">${actions}</div>` : ""}
    </article>
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

  const ownAll = ownedFolders();
  const shared = sharedFolders();
  const browseId = state.folderBrowseId || null;
  const own = ownAll.filter((folder) => (folder.parentId || null) === browseId);
  const breadcrumbs = [];
  let walk = browseId;
  while (walk && state.folders?.[walk]) { const f = state.folders[walk]; breadcrumbs.unshift({ id: walk, name: f.name || "Carpeta" }); walk = f.parentId || null; }
  if (elements.foldersBreadcrumb) {
    const rootBtn = `<button type="button" data-action="browse-root">Raíz</button>`;
    const trail = breadcrumbs.map((b)=>`<button type="button" data-action="browse" data-id="${b.id}">${b.name}</button>`).join(" / ");
    elements.foldersBreadcrumb.innerHTML = [rootBtn, trail].filter(Boolean).join(" / ");
  }
  if (!state.username) { container.innerHTML = "<div class=\"card\">Define tu usuario en Ajustes o al iniciar.</div>"; return; }
  if (!own.length && !shared.length) { container.innerHTML = "<div class=\"card\">Crea tu primera carpeta para organizar tus tarjetas.</div>"; return; }
  const list = document.createElement("div");
  list.className = "folder-list";
  own.forEach((folder) => {
    const item = document.createElement("div"); item.className = "folder-list-item";
    item.innerHTML = folderRowMarkup(folder, `${state.folderCardCounts?.[folder.id] || 0} tarjetas`, `data-owner-uid="${state.username}"`, `<button class="icon-button icon-button--compact" data-action="browse" data-id="${folder.id}" type="button" aria-label="Abrir subcarpetas">📂</button><button class="icon-button icon-button--compact" data-action="move" data-id="${folder.id}" type="button">Mover a…</button><button class="icon-button icon-button--compact" data-action="rename" data-id="${folder.id}" type="button" aria-label="Editar carpeta">✏️</button><button class="icon-button icon-button--compact icon-button--danger" data-action="delete" data-id="${folder.id}" type="button" aria-label="Eliminar carpeta">🗑️</button>`);
    list.appendChild(item);
  });
  if (!browseId) {
    shared.forEach((folder) => { const item = document.createElement("div"); item.className = "folder-list-item"; item.innerHTML = folderRowMarkup({ ...folder, id: folder.folderId }, `${folder.cardCount || 0} tarjetas · compartida`, `data-owner-uid="${folder.ownerUid}" data-shared="true"`); list.appendChild(item); });
  }
  container.appendChild(list);
  renderFolderSelects();
}
