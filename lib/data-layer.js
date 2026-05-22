import {
  createCard as createCardRtdb,
  createFolder as createFolderRtdb,
  deleteFolder as deleteFolderRtdb,
  fetchCardsByFolder,
  fetchCardsByFolderId,
  fetchFolders,
  getOrCreateFolderByPath,
  migrateCardsFolderIdsOnce,
  normalizeFoldersSnapshot,
  updateCard as updateCardRtdb,
  updateFolder as updateFolderRtdb,
  upsertCardWithDedupe,
} from "./rtdb.js";

const LEGACY_MIGRATION_FLAG = "chanki_migrated_folderIds";

export async function loadFolders(db, uid) {
  const folders = await fetchFolders(db, uid);
  const normalized = await normalizeFoldersSnapshot(db, uid, folders || {});
  return normalized.folders || {};
}

export async function loadCards(db, uid, folderId = null, limit = 5000) {
  if (!folderId) {
    const page = await fetchCardsByFolder(db, uid, null, limit, null);
    return page.cards || [];
  }
  return fetchCardsByFolderId(db, uid, folderId, limit);
}

export async function createFolder(db, uid, { name, emoji, color, reviewBothSides, sourceLang, targetLang, parentId = null }) {
  return createFolderRtdb(db, uid, { name, emoji, color, reviewBothSides, sourceLang, targetLang, parentId });
}

export async function updateFolder(db, uid, folderId, updates) {
  return updateFolderRtdb(db, uid, folderId, updates);
}

export async function deleteFolder(db, uid, folderId) {
  return deleteFolderRtdb(db, uid, folderId);
}

export async function createCard(db, uid, card, folderId = null) {
  return createCardRtdb(db, uid, { ...card, folderId });
}

export async function importCards(db, uid, cards, folderId = null) {
  const summary = { created: 0, updated: 0, duplicates: 0 };
  for (const card of cards) {
    const payload = {
      id: card.id,
      folderId,
      type: card.type || "basic",
      front: card.front,
      back: card.back,
      clozeText: card.clozeText,
      clozeAnswers: card.clozeAnswers || [],
      orderTokens: card.orderTokens || [],
      orderAnswer: card.orderAnswer || [],
      tags: card.tags || {},
    };
    const result = await upsertCardWithDedupe(db, uid, payload);
    if (result.status === "duplicate") summary.duplicates += 1;
    else if (result.status === "updated") summary.updated += 1;
    else summary.created += 1;
  }
  return summary;
}

export async function updateCard(db, uid, cardId, updates) {
  return updateCardRtdb(db, uid, cardId, updates);
}

export async function ensureFolderIdForImportPath(db, uid, legacyPath, cachedFolders = null) {
  return getOrCreateFolderByPath(db, uid, legacyPath, cachedFolders);
}

export async function migrateLegacyCardFoldersOnce(db, uid, limit = 2000) {
  if (localStorage.getItem(LEGACY_MIGRATION_FLAG) === "1") return { skipped: true };
  const result = await migrateCardsFolderIdsOnce(db, uid, limit);
  localStorage.setItem(LEGACY_MIGRATION_FLAG, "1");
  return result;
}
