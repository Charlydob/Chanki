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
  orderByChild,
  orderByKey,
  limitToFirst,
  startAfter,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { buildQueueKey, defaultSrs } from "./srs.js";

function normalizeDedupeValue(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?;,:]+$/g, "");
}

function normalizeContentValue(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .replace(/\s+/g, " ");
}

function buildDedupeKey(card) {
  const folderPart = normalizeDedupeValue(card.folderId || "");
  const type = card.type || "basic";
  if (type === "cloze") {
    const answersJoined = (card.clozeAnswers || []).join(" | ");
    return [
      folderPart,
      normalizeDedupeValue(card.clozeText || ""),
      normalizeDedupeValue(answersJoined),
    ].join("|");
  }
  return [folderPart, normalizeDedupeValue(card.front || "")].join("|");
}

function safeDedupeKey(key) {
  return encodeURIComponent(key);
}

function areCardContentsEqual(existing, incoming) {
  const existingType = existing?.type || "basic";
  const incomingType = incoming?.type || "basic";
  if (existingType !== incomingType) return false;
  if (existingType === "cloze") {
    const existingAnswers = (existing.clozeAnswers || []).map(normalizeContentValue);
    const incomingAnswers = (incoming.clozeAnswers || []).map(normalizeContentValue);
    if (existingAnswers.length !== incomingAnswers.length) return false;
    for (let i = 0; i < existingAnswers.length; i += 1) {
      if (existingAnswers[i] !== incomingAnswers[i]) return false;
    }
    return (
      normalizeContentValue(existing.clozeText || "") === normalizeContentValue(incoming.clozeText || "")
    );
  }
  return (
    normalizeContentValue(existing.front || "") === normalizeContentValue(incoming.front || "")
    && normalizeContentValue(existing.back || "") === normalizeContentValue(incoming.back || "")
  );
}

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
  const dedupeKey = safeDedupeKey(buildDedupeKey(payload));
  updates[`${root}/dedupe/${card.folderId}/${dedupeKey}`] = card.id;
  updates[`${root}/stats/totals/totalCards`] = increment(1);
  updates[`${root}/stats/totals/newCards`] = increment(1);
  updates[`${root}/stats/bucketCounts/new`] = increment(1);
  await update(ref(db), updates);
  return payload;
}

export async function upsertCardWithDedupe(db, username, card) {
  const root = userRoot(username);
  const type = card.type || "basic";
  const dedupeKey = safeDedupeKey(buildDedupeKey({ ...card, type }));
  const dedupePath = `${root}/dedupe/${card.folderId}/${dedupeKey}`;
  const snap = await get(child(ref(db), dedupePath));
  if (snap.exists()) {
    const cardId = snap.val();
    const existing = await fetchCard(db, username, cardId);
    if (existing) {
      const incomingPayload = {
        type,
        front: card.front || "",
        back: card.back || "",
        clozeText: card.clozeText || "",
        clozeAnswers: card.clozeAnswers || [],
        tags: card.tags || {},
      };
      if (areCardContentsEqual(existing, incomingPayload)) {
        return { status: "duplicate", cardId };
      }
      const mergedTags = {
        ...(existing.tags || {}),
        ...(card.tags || {}),
      };
      await updateCard(db, username, cardId, {
        ...incomingPayload,
        tags: mergedTags,
      });
      const existingKey = safeDedupeKey(buildDedupeKey(existing));
      if (existingKey !== dedupeKey) {
        const mappingUpdates = {};
        mappingUpdates[`${root}/dedupe/${existing.folderId}/${existingKey}`] = null;
        mappingUpdates[`${root}/dedupe/${card.folderId}/${dedupeKey}`] = cardId;
        await update(ref(db), mappingUpdates);
      }
      return { status: "updated", cardId };
    }
  }

  const payload = await createCard(db, username, card);
  return { status: "created", cardId: payload.id };
}

export async function updateCard(db, username, cardId, updates) {
  const root = userRoot(username);
  const now = Date.now();
  const snap = await get(child(ref(db), `${root}/cards/${cardId}`));
  const existing = snap.exists() ? snap.val() : null;
  await update(ref(db, `${root}/cards/${cardId}`), {
    ...updates,
    updatedAt: now,
  });
  if (!existing) return;
  const srs = existing.srs || defaultSrs();
  const bucket = srs.bucket || "new";
  const dueAt = srs.dueAt || existing.createdAt || now;
  const folderId = updates.folderId || existing.folderId;
  const mergedCard = {
    ...existing,
    ...updates,
  };
  const existingKey = safeDedupeKey(buildDedupeKey(existing));
  const nextKey = safeDedupeKey(buildDedupeKey(mergedCard));
  const key = buildQueueKey(dueAt, cardId);
  const queueUpdates = {};
  queueUpdates[`${root}/queue/${bucket}/${key}`] = true;
  if (folderId) {
    queueUpdates[`${root}/folderQueue/${folderId}/${bucket}/${key}`] = true;
  }
  if (!existing.srs || !existing.srs.bucket || !existing.srs.dueAt) {
    queueUpdates[`${root}/cards/${cardId}/srs`] = {
      ...defaultSrs(),
      ...existing.srs,
      bucket,
      dueAt,
    };
  }
  if (existingKey !== nextKey || existing.folderId !== mergedCard.folderId) {
    queueUpdates[`${root}/dedupe/${existing.folderId}/${existingKey}`] = null;
    if (mergedCard.folderId) {
      queueUpdates[`${root}/dedupe/${mergedCard.folderId}/${nextKey}`] = cardId;
    }
  }
  if (Object.keys(queueUpdates).length) {
    await update(ref(db), queueUpdates);
  }
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

function parseQueueCardId(queueKey) {
  if (!queueKey) return null;
  const separatorIndex = queueKey.indexOf("_");
  if (separatorIndex === -1) return null;
  return queueKey.slice(separatorIndex + 1) || null;
}

function getCardTags(card) {
  if (!card?.tags) return [];
  return Object.keys(card.tags).map((tag) => tag.toLowerCase());
}

export async function buildSessionQueue({
  db,
  username,
  folderIdOrAll,
  buckets,
  maxCards,
  maxNew = null,
  maxReviews = null,
  tagFilter = [],
  allowRepair = false,
}) {
  const folderId = folderIdOrAll === "all" ? null : folderIdOrAll;
  const root = userRoot(username);
  const cardIds = [];
  const bucketCounts = {};
  const seen = new Set();

  for (const bucket of buckets) {
    if (cardIds.length >= maxCards) break;
    let needed = maxCards - cardIds.length;
    if (bucket === "new" && Number.isFinite(maxNew)) {
      needed = Math.min(needed, maxNew);
    } else if (bucket !== "new" && Number.isFinite(maxReviews)) {
      needed = Math.min(needed, maxReviews);
    }
    if (needed <= 0) {
      bucketCounts[bucket] = 0;
      continue;
    }
    const keys = await fetchQueueKeys(db, username, bucket, folderId, needed);
    bucketCounts[bucket] = keys.length;
    for (const key of keys) {
      const cardId = parseQueueCardId(key);
      if (!cardId || seen.has(cardId)) continue;
      seen.add(cardId);
      cardIds.push(cardId);
      if (cardIds.length >= maxCards) break;
    }
  }

  if (cardIds.length) {
    return {
      cardIds,
      bucketCounts,
      fallbackCount: 0,
      usedFallback: false,
      repaired: false,
    };
  }

  const fallbackCards = [];
  const cardsRef = query(ref(db, `${root}/cards`), orderByChild("srs/dueAt"), limitToFirst(200));
  const snap = await get(cardsRef);
  if (snap.exists()) {
    snap.forEach((childSnap) => {
      const card = childSnap.val();
      fallbackCards.push({ id: childSnap.key, ...card });
    });
  }

  const now = Date.now();
  const normalizedTags = tagFilter.map((tag) => tag.toLowerCase());
  const filtered = fallbackCards.filter((card) => {
    if (!card) return false;
    const bucket = card.srs?.bucket || "new";
    if (!buckets.includes(bucket)) return false;
    if (folderId && card.folderId !== folderId) return false;
    if (normalizedTags.length) {
      const cardTags = getCardTags(card);
      if (!normalizedTags.every((tag) => cardTags.includes(tag))) {
        return false;
      }
    }
    const dueAt = card.srs?.dueAt || card.createdAt || 0;
    if (bucket !== "new" && dueAt > now) return false;
    return true;
  });

  for (const bucket of buckets) {
    if (cardIds.length >= maxCards) break;
    let needed = maxCards - cardIds.length;
    if (bucket === "new" && Number.isFinite(maxNew)) {
      needed = Math.min(needed, maxNew);
    } else if (bucket !== "new" && Number.isFinite(maxReviews)) {
      needed = Math.min(needed, maxReviews);
    }
    if (needed <= 0) continue;
    const bucketCards = filtered.filter((card) => (card.srs?.bucket || "new") === bucket);
    let added = 0;
    for (const card of bucketCards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cardIds.push(card.id);
      added += 1;
      if (cardIds.length >= maxCards || added >= needed) break;
    }
  }

  let repaired = false;
  if (allowRepair && filtered.length) {
    const repairResult = await repairIndexesOnce(db, username, filtered, 200);
    repaired = repairResult.repaired;
  }

  return {
    cardIds,
    bucketCounts,
    fallbackCount: filtered.length,
    usedFallback: filtered.length > 0,
    repaired,
  };
}

export async function repairIndexesOnce(db, username, cards = null, limit = 200) {
  const root = userRoot(username);
  let cardsToRepair = cards;
  if (!cardsToRepair) {
    const cardsRef = query(ref(db, `${root}/cards`), orderByKey(), limitToFirst(limit));
    const snap = await get(cardsRef);
    if (!snap.exists()) {
      return { repaired: false, count: 0 };
    }
    cardsToRepair = Object.entries(snap.val()).map(([cardId, card]) => ({ id: cardId, ...card }));
  }

  const updates = {};
  let count = 0;
  cardsToRepair.slice(0, limit).forEach((card) => {
    if (!card) return;
    const srs = card.srs || defaultSrs();
    const bucket = srs.bucket || "new";
    const dueAt = srs.dueAt || card.createdAt || Date.now();
    const key = buildQueueKey(dueAt, card.id);
    updates[`${root}/queue/${bucket}/${key}`] = true;
    if (card.folderId) {
      updates[`${root}/folderQueue/${card.folderId}/${bucket}/${key}`] = true;
    }
    if (!card.srs || !card.srs.bucket || !card.srs.dueAt) {
      updates[`${root}/cards/${card.id}/srs`] = {
        ...defaultSrs(),
        ...card.srs,
        bucket,
        dueAt,
      };
    }
    count += 1;
  });
  if (Object.keys(updates).length) {
    await update(ref(db), updates);
  }
  return { repaired: count > 0, count };
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
