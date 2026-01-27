import { elements, state } from "../shared.js";
import { refreshReviewBucketCounts } from "./review.js";

// moved from app.js
export function renderFolderSelects() {
  const options = elements.reviewFolderOptions;
  if (!options) return;
  options.innerHTML = "";
  const selected = new Set(state.reviewSelectedFolderIds || []);
  const allChecked = selected.size === 0;

  const addOption = (value, label, checked) => {
    const item = document.createElement("label");
    item.className = "folder-select-item";
    item.innerHTML = `
      <input type="checkbox" value="${value}" ${checked ? "checked" : ""} />
      <span class="folder-select-item__label">${label}</span>
    `;
    options.appendChild(item);
  };

  addOption("all", "Todas", allChecked);

  const ownedFolders = Object.values(state.folders);
  if (ownedFolders.length) {
    const title = document.createElement("div");
    title.className = "list-section-title";
    title.textContent = "Mis carpetas";
    options.appendChild(title);
    ownedFolders.forEach((folder) => {
      addOption(folder.id, folder.name, selected.has(folder.id));
    });
  }

  const sharedEntries = Object.entries(state.sharedFolders || {});
  if (sharedEntries.length) {
    const title = document.createElement("div");
    title.className = "list-section-title";
    title.textContent = "Compartidas conmigo";
    options.appendChild(title);
    sharedEntries.forEach(([shareKey, folder]) => {
      if (!folder?.folderId) return;
      const ownerInfo = state.usersPublic?.[folder.ownerUid];
      const ownerLabel = ownerInfo?.displayName || ownerInfo?.handle || folder.ownerUid;
      addOption(
        `shared:${shareKey}`,
        `Compartida · ${folder.name || "Carpeta"} · ${ownerLabel}`,
        selected.has(`shared:${shareKey}`)
      );
    });
  }

  if (elements.reviewFolderLabel) {
    if (!selected.size) {
      elements.reviewFolderLabel.textContent = "Todas";
    } else if (selected.size === 1) {
      const value = [...selected][0];
      if (value.startsWith("shared:")) {
        const shareKey = value.replace("shared:", "");
        const folder = state.sharedFolders?.[shareKey];
        const ownerInfo = state.usersPublic?.[folder?.ownerUid];
        const ownerLabel = ownerInfo?.displayName || ownerInfo?.handle || folder?.ownerUid || "";
        elements.reviewFolderLabel.textContent = `Compartida · ${folder?.name || "Carpeta"} · ${ownerLabel}`;
      } else {
        elements.reviewFolderLabel.textContent = state.folders[value]?.name || "Carpeta";
      }
    } else {
      elements.reviewFolderLabel.textContent = `${selected.size} carpetas`;
    }
  }

  refreshReviewBucketCounts();
}

// moved from app.js
export function renderFolders() {
  const container = elements.folderTree;
  container.innerHTML = "";
  const folderList = Object.values(state.folders);
  const sharedList = Object.entries(state.sharedFolders || {})
    .map(([shareKey, folder]) => ({ ...folder, shareKey }))
    .filter((folder) => folder?.folderId || folder?.id);
  if (!state.username) {
    container.innerHTML = "<div class=\"card\">Define tu usuario en Ajustes o al iniciar.</div>";
    return;
  }
  if (!folderList.length && !sharedList.length) {
    container.innerHTML = "<div class=\"card\">Crea tu primera carpeta para organizar tus tarjetas.</div>";
    return;
  }
  if (folderList.length) {
    const ownedTitle = document.createElement("div");
    ownedTitle.className = "list-section-title";
    ownedTitle.textContent = "Mis carpetas";
    container.appendChild(ownedTitle);
  }
  folderList.forEach((folder) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const menuId = `folder-menu-${folder.id}`;
    const subtitle = typeof folder.cardCount === "number"
      ? `${folder.cardCount} tarjetas`
      : folder.path;
    item.innerHTML = `
      <button class="item-main" data-action="select" data-id="${folder.id}" data-owner-uid="${state.username}" type="button">
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
          <button data-action="share" data-id="${folder.id}" type="button">Compartir</button>
          <button data-action="rename" data-id="${folder.id}" type="button">Renombrar</button>
          <button data-action="delete" data-id="${folder.id}" type="button" class="danger">Borrar</button>
        </div>
      </div>
    `;
    container.appendChild(item);
  });
  if (sharedList.length) {
    const sharedTitle = document.createElement("div");
    sharedTitle.className = "list-section-title";
    sharedTitle.textContent = "Compartidas conmigo";
    container.appendChild(sharedTitle);
  }
  sharedList.forEach((folder) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const ownerInfo = state.usersPublic?.[folder.ownerUid];
    const ownerLabel = ownerInfo?.displayName || ownerInfo?.handle || folder.ownerUid;
    const subtitle = typeof folder.cardCount === "number"
      ? `${folder.cardCount} tarjetas · ${ownerLabel}`
      : `${folder.path || "Compartida"} · ${ownerLabel}`;
    item.innerHTML = `
      <button class="item-main" data-action="select" data-id="${folder.folderId}" data-owner-uid="${folder.ownerUid}" data-role="${folder.role || "viewer"}" data-shared="true" type="button">
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
          <span class="item-title-row">
            <span class="item-title">${folder.name || "Carpeta"}</span>
            <span class="share-badge">Compartida</span>
          </span>
          <span class="item-subtitle">${subtitle}</span>
        </span>
        <span class="item-chevron" aria-hidden="true">›</span>
      </button>
    `;
    container.appendChild(item);
  });
  renderFolderSelects();
}
