import {
  ref,
  child,
  get,
  set,
  update,
  remove,
  onValue,
  increment,
  query,
  orderByKey,
  limitToFirst,
  startAfter,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { buildQueueKey, defaultSrs } from "./srs.js";

export function userRoot(username) {
  return `/u/${encodeURIComponent(username)}`;
}

export function listenFolders(db, username, callback) {
  const root = userRoot(username);
  return onValue(ref(db, `${root}/folders`), (snap) => {
    callback(snap.exists() ? snap.val() : {});
  });
}

export async function createFolder(db, username, folder) {
  const root = userRoot(username);
  const now = Date.now();
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `folder_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const payload = {
    id,
    name: folder.name,
    parentId: null,
    path: folder.name,
    createdAt: now,
    updatedAt: now,
  };
  await set(ref(db, `${root}/folders/${id}`), payload);
  return id;
}

export async function updateFolder(db, username, folderId, updates) {
  const root = userRoot(username);
  await update(ref(db, `${root}/folders/${folderId}`), {
    ...updates,
    updatedAt: Date.now(),
  });
}

export async function deleteFolder(db, username, folderId) {
  const root = userRoot(username);
  await remove(ref(db, `${root}/folders/${folderId}`));
}

export async function createCard(db, username, card) {
  const root = userRoot(username);
  const now = Date.now();
  const srs = {
    ...defaultSrs(),
    dueAt: now,
    bucket: "new",
  };
  const type = card.type || "basic";
  const payload = {
    id: card.id,
    folderId: card.folderId,
    type,
    front: card.front || "",
    back: card.back || "",
    clozeText: card.clozeText || "",
    clozeAnswers: card.clozeAnswers || [],
    tags: card.tags || {},
    createdAt: now,
    updatedAt: now,
    srs,
  };
  const key = buildQueueKey(srs.dueAt, card.id);
  const updates = {};
  updates[`${root}/cards/${card.id}`] = payload;
  updates[`${root}/queue/new/${key}`] = true;
  updates[`${root}/folderQueue/${card.folderId}/new/${key}`] = true;
  updates[`${root}/stats/totals/totalCards`] = increment(1);
  updates[`${root}/stats/totals/newCards`] = increment(1);
  updates[`${root}/stats/bucketCounts/new`] = increment(1);
  await update(ref(db), updates);
  return payload;
}

export async function updateCard(db, username, cardId, updates) {
  const root = userRoot(username);
  await update(ref(db, `${root}/cards/${cardId}`), {
    ...updates,
    updatedAt: Date.now(),
  });
}

export async function deleteCard(db, username, card) {
  const root = userRoot(username);
  const bucket = card.srs?.bucket || "new";
  const dueAt = card.srs?.dueAt || Date.now();
  const key = buildQueueKey(dueAt, card.id);
  const updates = {};
  updates[`${root}/cards/${card.id}`] = null;
  updates[`${root}/queue/${bucket}/${key}`] = null;
  updates[`${root}/folderQueue/${card.folderId}/${bucket}/${key}`] = null;
  updates[`${root}/stats/totals/totalCards`] = increment(-1);
  if (bucket === "new") {
    updates[`${root}/stats/totals/newCards`] = increment(-1);
  } else {
    updates[`${root}/stats/totals/learnedCards`] = increment(-1);
  }
  updates[`${root}/stats/bucketCounts/${bucket}`] = increment(-1);
  await update(ref(db), updates);
}

export async function moveCardFolder(db, username, card, newFolderId) {
  const root = userRoot(username);
  const currentKey = buildQueueKey(card.srs.dueAt, card.id);
  const updates = {};
  updates[`${root}/cards/${card.id}/folderId`] = newFolderId;
  updates[`${root}/folderQueue/${card.folderId}/${card.srs.bucket}/${currentKey}`] = null;
  updates[`${root}/folderQueue/${newFolderId}/${card.srs.bucket}/${currentKey}`] = true;
  await update(ref(db), updates);
}

export async function updateReview(db, username, card, nextSrs) {
  const root = userRoot(username);
  const oldKey = buildQueueKey(card.srs.dueAt, card.id);
  const newKey = buildQueueKey(nextSrs.dueAt, card.id);
  const updates = {};
  updates[`${root}/cards/${card.id}/srs`] = nextSrs;
  updates[`${root}/queue/${card.srs.bucket}/${oldKey}`] = null;
  updates[`${root}/queue/${nextSrs.bucket}/${newKey}`] = true;
  updates[`${root}/folderQueue/${card.folderId}/${card.srs.bucket}/${oldKey}`] = null;
  updates[`${root}/folderQueue/${card.folderId}/${nextSrs.bucket}/${newKey}`] = true;
  if (card.srs.bucket !== nextSrs.bucket) {
    updates[`${root}/stats/bucketCounts/${card.srs.bucket}`] = increment(-1);
    updates[`${root}/stats/bucketCounts/${nextSrs.bucket}`] = increment(1);
    if (card.srs.bucket === "new" && nextSrs.bucket !== "new") {
      updates[`${root}/stats/totals/newCards`] = increment(-1);
      updates[`${root}/stats/totals/learnedCards`] = increment(1);
    }
  }
  await update(ref(db), updates);
}

export async function fetchCardsByFolder(db, username, folderId, pageSize = 20, startKey = null) {
  const root = userRoot(username);
  const cardsRef = ref(db, `${root}/cards`);
  let cardsQuery = query(cardsRef, orderByKey(), limitToFirst(pageSize * 3));
  if (startKey) {
    cardsQuery = query(cardsRef, orderByKey(), startAfter(startKey), limitToFirst(pageSize * 3));
  }
  const snap = await get(cardsQuery);
  const all = snap.exists() ? snap.val() : {};
  const entries = Object.entries(all);
  let filtered = entries.filter(([, value]) => value.folderId === folderId);
  if (filtered.length > pageSize) {
    filtered = filtered.slice(0, pageSize);
  }
  const lastKey = entries.length ? entries[entries.length - 1][0] : null;
  return {
    cards: filtered.map(([id, value]) => ({ id, ...value })),
    lastKey,
  };
}

export async function fetchQueueKeys(db, username, bucket, folderId, limit = 10) {
  const root = userRoot(username);
  const base = folderId ? `${root}/folderQueue/${folderId}/${bucket}` : `${root}/queue/${bucket}`;
  const queueRef = query(ref(db, base), orderByKey(), limitToFirst(limit));
  const snap = await get(queueRef);
  if (!snap.exists()) {
    return [];
  }
  return Object.keys(snap.val());
}

export async function fetchCard(db, username, cardId) {
  const root = userRoot(username);
  const snap = await get(child(ref(db), `${root}/cards/${cardId}`));
  return snap.exists() ? { id: cardId, ...snap.val() } : null;
}

export async function fetchUserData(db, username) {
  const root = userRoot(username);
  const snap = await get(ref(db, root));
  return snap.exists() ? snap.val() : {};
}

export async function fetchGlossaryWord(db, username, wordKey) {
  const root = userRoot(username);
  const safeKey = encodeURIComponent(wordKey);
  const snap = await get(child(ref(db), `${root}/glossary/${safeKey}`));
  return snap.exists() ? snap.val() : null;
}

export async function upsertGlossaryEntries(db, username, entries) {
  const root = userRoot(username);
  const updates = {};
  entries.forEach((entry) => {
    const safeKey = encodeURIComponent(entry.key);
    updates[`${root}/glossary/${safeKey}`] = {
      word: entry.word,
      meaning: entry.meaning,
      updatedAt: Date.now(),
    };
  });
  await update(ref(db), updates);
}
