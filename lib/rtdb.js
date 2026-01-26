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
  equalTo,
  limitToFirst,
  startAt,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { buildQueueKey, defaultSrs } from "./srs.js";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.?!…]+$/g, "");
}

export function normalizeFolderPath(path) {
  if (!path) return "";
  return String(path)
    .trim()
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function normalizeContentValue(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .replace(/\s+/g, " ");
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

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase();
}

function mapToTags(tagsMap) {
  if (!tagsMap) return [];
  return Object.keys(tagsMap).map(normalizeTag).filter(Boolean);
}

function buildTagsIndexUpdates(root, tags) {
  const updates = {};
  tags.forEach((tag) => {
    updates[`${root}/tagsIndex/${tag}`] = true;
  });
  return updates;
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

async function buildCardDedupe(card) {
  const values = getCardDedupeValues(card);
  const normFront = normalizeText(values.front);
  const normBack = normalizeText(values.back);
  const [frontHash, backHash] = await Promise.all([
    normFront ? hashKey(normFront, 16) : "",
    normBack ? hashKey(normBack, 16) : "",
  ]);
  return {
    normFront,
    normBack,
    frontHash,
    backHash,
  };
}

async function resolveDedupeMatch(db, root, entry, expectedNorm, side) {
  if (!entry || !expectedNorm) return null;
  if (typeof entry === "string") {
    const cardSnap = await get(child(ref(db), `${root}/cards/${entry}`));
    if (!cardSnap.exists()) return null;
    const cardData = cardSnap.val();
    const cardDedupe = await buildCardDedupe(cardData);
    const norm = side === "front" ? cardDedupe.normFront : cardDedupe.normBack;
    return norm && norm === expectedNorm ? entry : null;
  }
  if (!entry?.cardId) return null;
  if (entry.norm) {
    return entry.norm === expectedNorm ? entry.cardId : null;
  }
  const cardSnap = await get(child(ref(db), `${root}/cards/${entry.cardId}`));
  if (!cardSnap.exists()) return null;
  const cardData = cardSnap.val();
  const cardDedupe = await buildCardDedupe(cardData);
  const norm = side === "front" ? cardDedupe.normFront : cardDedupe.normBack;
  return norm && norm === expectedNorm ? entry.cardId : null;
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

export async function getOrCreateFolderByPath(db, username, path, cachedFolders = null) {
  const root = userRoot(username);
  const normalizedPath = normalizeFolderPath(path);
  if (!normalizedPath) return null;
  let foldersMap = cachedFolders;
  if (!foldersMap) {
    const snap = await get(ref(db, `${root}/folders`));
    foldersMap = snap.exists() ? snap.val() : {};
  }
  const foldersList = Object.values(foldersMap || {});
  const found = foldersList.find((folder) => normalizeFolderPath(folder.path || folder.name) === normalizedPath);
  if (found) {
    return found.id;
  }
  const now = Date.now();
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `folder_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const segments = normalizedPath.split("/");
  const payload = {
    id,
    name: segments[segments.length - 1],
    parentId: null,
    path: normalizedPath,
    createdAt: now,
    updatedAt: now,
  };
  await set(ref(db, `${root}/folders/${id}`), payload);
  if (foldersMap) {
    foldersMap[id] = payload;
  }
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

export async function createCard(db, username, card, options = null) {
  const root = userRoot(username);
  const now = Date.now();
  const dedupe = options?.dedupe || await buildCardDedupe(card);
  const allowFront = options?.allowFront !== false;
  const allowBack = options?.allowBack !== false;
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
  if (allowFront && dedupe.frontHash) {
    updates[`${root}/dedupeFront/${card.folderId}/${dedupe.frontHash}`] = {
      cardId: card.id,
      norm: dedupe.normFront,
    };
  }
  if (allowBack && dedupe.backHash) {
    updates[`${root}/dedupeBack/${card.folderId}/${dedupe.backHash}`] = {
      cardId: card.id,
      norm: dedupe.normBack,
    };
  }
  updates[`${root}/stats/totals/totalCards`] = increment(1);
  updates[`${root}/stats/totals/newCards`] = increment(1);
  updates[`${root}/stats/bucketCounts/new`] = increment(1);
  Object.assign(updates, buildTagsIndexUpdates(root, mapToTags(payload.tags)));
  await update(ref(db), updates);
  return payload;
}

export async function upsertCardWithDedupe(db, username, card) {
  const root = userRoot(username);
  const type = card.type || "basic";
  const dedupePayload = { ...card, type };
  const dedupe = await buildCardDedupe(dedupePayload);
  const frontSnap = dedupe.frontHash
    ? await get(child(ref(db), `${root}/dedupeFront/${card.folderId}/${dedupe.frontHash}`))
    : null;
  const backSnap = dedupe.backHash
    ? await get(child(ref(db), `${root}/dedupeBack/${card.folderId}/${dedupe.backHash}`))
    : null;
  const frontEntry = frontSnap && frontSnap.exists() ? frontSnap.val() : null;
  const backEntry = backSnap && backSnap.exists() ? backSnap.val() : null;

  const frontMatch = dedupe.normFront
    ? await resolveDedupeMatch(db, root, frontEntry, dedupe.normFront, "front")
    : null;
  const backMatch = dedupe.normBack
    ? await resolveDedupeMatch(db, root, backEntry, dedupe.normBack, "back")
    : null;
  const matchedCardId = frontMatch || backMatch;
  if (matchedCardId) {
    const cardId = matchedCardId;
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
      }, { dedupeCheck: false });
      return { status: "updated", cardId };
    }
  }

  const payload = await createCard(db, username, card, {
    dedupe,
    allowFront: !frontEntry || frontMatch,
    allowBack: !backEntry || backMatch,
  });
  return { status: "created", cardId: payload.id };
}

export async function updateCard(db, username, cardId, updates, options = {}) {
  const root = userRoot(username);
  const now = Date.now();
  const snap = await get(child(ref(db), `${root}/cards/${cardId}`));
  const existing = snap.exists() ? snap.val() : null;
  if (!existing) return null;
  const dedupeCheck = options?.dedupeCheck !== false;
  const mergedCard = {
    ...existing,
    ...updates,
  };
  if (dedupeCheck && mergedCard.folderId) {
    const dedupe = await buildCardDedupe(mergedCard);
    const [frontSnap, backSnap] = await Promise.all([
      dedupe.frontHash
        ? get(child(ref(db), `${root}/dedupeFront/${mergedCard.folderId}/${dedupe.frontHash}`))
        : null,
      dedupe.backHash
        ? get(child(ref(db), `${root}/dedupeBack/${mergedCard.folderId}/${dedupe.backHash}`))
        : null,
    ]);
    const frontEntry = frontSnap?.exists() ? frontSnap.val() : null;
    const backEntry = backSnap?.exists() ? backSnap.val() : null;
    const frontMatch = dedupe.normFront
      ? await resolveDedupeMatch(db, root, frontEntry, dedupe.normFront, "front")
      : null;
    const backMatch = dedupe.normBack
      ? await resolveDedupeMatch(db, root, backEntry, dedupe.normBack, "back")
      : null;
    const duplicateId = (frontMatch || backMatch) && (frontMatch || backMatch) !== cardId
      ? (frontMatch || backMatch)
      : null;
    if (duplicateId) {
      const duplicateSnap = await get(child(ref(db), `${root}/cards/${duplicateId}`));
      if (duplicateSnap.exists()) {
        const duplicateCard = duplicateSnap.val();
        const mergedTags = {
          ...(duplicateCard.tags || {}),
          ...(existing.tags || {}),
          ...(updates.tags || {}),
        };
        const dedupeUpdates = {};
        dedupeUpdates[`${root}/cards/${duplicateId}/tags`] = mergedTags;
        dedupeUpdates[`${root}/cards/${duplicateId}/updatedAt`] = now;
        Object.assign(dedupeUpdates, buildTagsIndexUpdates(root, mapToTags(mergedTags)));
        await update(ref(db), dedupeUpdates);
      }
      return { status: "duplicate", cardId: duplicateId };
    }
  }
  await update(ref(db, `${root}/cards/${cardId}`), {
    ...updates,
    updatedAt: now,
  });
  const srs = existing.srs || defaultSrs();
  const bucket = srs.bucket || "new";
  const dueAt = srs.dueAt || existing.createdAt || now;
  const folderId = updates.folderId || existing.folderId;
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
  const existingDedupe = await buildCardDedupe(existing);
  const nextDedupe = await buildCardDedupe(mergedCard);
  const folderChanged = existing.folderId !== mergedCard.folderId;
  const shouldRemoveFront = existingDedupe.frontHash
    && (folderChanged || existingDedupe.frontHash !== nextDedupe.frontHash || existingDedupe.normFront !== nextDedupe.normFront);
  const shouldRemoveBack = existingDedupe.backHash
    && (folderChanged || existingDedupe.backHash !== nextDedupe.backHash || existingDedupe.normBack !== nextDedupe.normBack);
  if (shouldRemoveFront) {
    const frontSnap = await get(
      child(ref(db), `${root}/dedupeFront/${existing.folderId}/${existingDedupe.frontHash}`)
    );
    const frontValue = frontSnap.exists() ? frontSnap.val() : null;
    if (frontValue === cardId || frontValue?.cardId === cardId) {
      queueUpdates[`${root}/dedupeFront/${existing.folderId}/${existingDedupe.frontHash}`] = null;
    }
  }
  if (shouldRemoveBack) {
    const backSnap = await get(
      child(ref(db), `${root}/dedupeBack/${existing.folderId}/${existingDedupe.backHash}`)
    );
    const backValue = backSnap.exists() ? backSnap.val() : null;
    if (backValue === cardId || backValue?.cardId === cardId) {
      queueUpdates[`${root}/dedupeBack/${existing.folderId}/${existingDedupe.backHash}`] = null;
    }
  }
  if (mergedCard.folderId) {
    if (nextDedupe.frontHash) {
      const frontSnap = await get(
        child(ref(db), `${root}/dedupeFront/${mergedCard.folderId}/${nextDedupe.frontHash}`)
      );
      const frontEntry = frontSnap.exists() ? frontSnap.val() : null;
      const frontCollision = frontEntry?.cardId && frontEntry.cardId !== cardId && frontEntry.norm !== nextDedupe.normFront;
      if (!frontCollision) {
        queueUpdates[`${root}/dedupeFront/${mergedCard.folderId}/${nextDedupe.frontHash}`] = {
          cardId,
          norm: nextDedupe.normFront,
        };
      }
    }
    if (nextDedupe.backHash) {
      const backSnap = await get(
        child(ref(db), `${root}/dedupeBack/${mergedCard.folderId}/${nextDedupe.backHash}`)
      );
      const backEntry = backSnap.exists() ? backSnap.val() : null;
      const backCollision = backEntry?.cardId && backEntry.cardId !== cardId && backEntry.norm !== nextDedupe.normBack;
      if (!backCollision) {
        queueUpdates[`${root}/dedupeBack/${mergedCard.folderId}/${nextDedupe.backHash}`] = {
          cardId,
          norm: nextDedupe.normBack,
        };
      }
    }
  }
  Object.assign(queueUpdates, buildTagsIndexUpdates(root, mapToTags(mergedCard.tags)));
  if (Object.keys(queueUpdates).length) {
    await update(ref(db), queueUpdates);
  }
  return { status: "updated", cardId };
}

export async function deleteCard(db, username, card) {
  const root = userRoot(username);
  const bucket = card.srs?.bucket || "new";
  const dueAt = card.srs?.dueAt || Date.now();
  const key = buildQueueKey(dueAt, card.id);
  const updates = {};
  updates[`${root}/cards/${card.id}`] = null;
  updates[`${root}/queue/${bucket}/${key}`] = null;
  if (card.folderId) {
    updates[`${root}/folderQueue/${card.folderId}/${bucket}/${key}`] = null;
  }
  const dedupe = await buildCardDedupe(card);
  if (card.folderId && (dedupe.frontHash || dedupe.backHash)) {
    const [frontSnap, backSnap] = await Promise.all([
      dedupe.frontHash ? get(child(ref(db), `${root}/dedupeFront/${card.folderId}/${dedupe.frontHash}`)) : null,
      dedupe.backHash ? get(child(ref(db), `${root}/dedupeBack/${card.folderId}/${dedupe.backHash}`)) : null,
    ]);
    if (dedupe.frontHash && frontSnap?.exists() && frontSnap.val()?.cardId === card.id) {
      updates[`${root}/dedupeFront/${card.folderId}/${dedupe.frontHash}`] = null;
    }
    if (dedupe.backHash && backSnap?.exists() && backSnap.val()?.cardId === card.id) {
      updates[`${root}/dedupeBack/${card.folderId}/${dedupe.backHash}`] = null;
    }
  }
  if (card.folderId) {
    const [frontMapSnap, backMapSnap] = await Promise.all([
      get(ref(db, `${root}/dedupeFront/${card.folderId}`)),
      get(ref(db, `${root}/dedupeBack/${card.folderId}`)),
    ]);
    if (frontMapSnap.exists()) {
      frontMapSnap.forEach((childSnap) => {
        const value = childSnap.val();
        if (value === card.id || value?.cardId === card.id) {
          updates[`${root}/dedupeFront/${card.folderId}/${childSnap.key}`] = null;
        }
      });
    }
    if (backMapSnap.exists()) {
      backMapSnap.forEach((childSnap) => {
        const value = childSnap.val();
        if (value === card.id || value?.cardId === card.id) {
          updates[`${root}/dedupeBack/${card.folderId}/${childSnap.key}`] = null;
        }
      });
    }
  }
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
  const dedupe = await buildCardDedupe(card);
  if (dedupe.frontHash) {
    const frontSnap = await get(
      child(ref(db), `${root}/dedupeFront/${card.folderId}/${dedupe.frontHash}`)
    );
    const frontValue = frontSnap.exists() ? frontSnap.val() : null;
    if (frontValue === card.id || frontValue?.cardId === card.id) {
      updates[`${root}/dedupeFront/${card.folderId}/${dedupe.frontHash}`] = null;
    }
    updates[`${root}/dedupeFront/${newFolderId}/${dedupe.frontHash}`] = {
      cardId: card.id,
      norm: dedupe.normFront,
    };
  }
  if (dedupe.backHash) {
    const backSnap = await get(
      child(ref(db), `${root}/dedupeBack/${card.folderId}/${dedupe.backHash}`)
    );
    const backValue = backSnap.exists() ? backSnap.val() : null;
    if (backValue === card.id || backValue?.cardId === card.id) {
      updates[`${root}/dedupeBack/${card.folderId}/${dedupe.backHash}`] = null;
    }
    updates[`${root}/dedupeBack/${newFolderId}/${dedupe.backHash}`] = {
      cardId: card.id,
      norm: dedupe.normBack,
    };
  }
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

export async function fetchCardsByFolder(db, username, folderId, pageSize = 20, cursor = null) {
  const root = userRoot(username);
  const cardsRef = ref(db, `${root}/cards`);
  const fetchLimit = pageSize * 5;
  let cardsQuery = query(cardsRef, orderByChild("createdAt"), limitToFirst(fetchLimit));
  if (cursor?.createdAt) {
    cardsQuery = query(
      cardsRef,
      orderByChild("createdAt"),
      startAt(cursor.createdAt + 1),
      limitToFirst(fetchLimit)
    );
  }
  const snap = await get(cardsQuery);
  const entries = [];
  if (snap.exists()) {
    snap.forEach((childSnap) => {
      entries.push([childSnap.key, childSnap.val()]);
    });
  }
  const filtered = entries.filter(([, value]) => !folderId || value.folderId === folderId);
  const pageEntries = filtered.slice(0, pageSize);
  const lastEntry = entries.length ? entries[entries.length - 1] : null;
  const lastCursor = lastEntry
    ? { id: lastEntry[0], createdAt: lastEntry[1]?.createdAt || 0 }
    : null;
  const hasMore = entries.length >= fetchLimit;
  return {
    cards: pageEntries.map(([id, value]) => ({ id, ...value })),
    cursor: lastCursor,
    hasMore,
  };
}

export async function fetchCardsByFolderId(db, username, folderId, limit = 500) {
  if (!folderId) return [];
  const root = userRoot(username);
  const cardsRef = ref(db, `${root}/cards`);
  const cardsQuery = query(cardsRef, orderByChild("folderId"), equalTo(folderId), limitToFirst(limit));
  const snap = await get(cardsQuery);
  const entries = [];
  if (snap.exists()) {
    snap.forEach((childSnap) => {
      entries.push({ id: childSnap.key, ...childSnap.val() });
    });
  }
  return entries;
}

export async function fetchCardsByFolderQueue(db, username, folderId, limit = 2000) {
  if (!folderId) return { cards: [], total: 0, hasMore: false };
  const root = userRoot(username);
  const queueSnap = await get(ref(db, `${root}/folderQueue/${folderId}`));
  if (!queueSnap.exists()) {
    return { cards: [], total: 0, hasMore: false };
  }
  const queueKeys = [];
  const queueEntries = [];
  queueSnap.forEach((bucketSnap) => {
    bucketSnap.forEach((keySnap) => {
      queueKeys.push(keySnap.key);
      queueEntries.push({ bucket: bucketSnap.key, key: keySnap.key });
    });
  });
  queueKeys.sort();
  const cardIds = [];
  const seen = new Set();
  queueKeys.forEach((key) => {
    const cardId = parseQueueCardId(key);
    if (!cardId || seen.has(cardId)) return;
    seen.add(cardId);
    cardIds.push(cardId);
  });
  const limitedIds = cardIds.slice(0, limit);
  const cardSnaps = await Promise.all(
    limitedIds.map((cardId) => get(child(ref(db), `${root}/cards/${cardId}`)))
  );
  const missingCardIds = new Set();
  const cards = cardSnaps
    .map((snap, index) => {
      if (!snap.exists()) {
        missingCardIds.add(limitedIds[index]);
        return null;
      }
      return { id: limitedIds[index], ...snap.val() };
    })
    .filter(Boolean);
  if (missingCardIds.size) {
    const cleanupUpdates = {};
    queueEntries.forEach((entry) => {
      const cardId = parseQueueCardId(entry.key);
      if (!cardId || !missingCardIds.has(cardId)) return;
      cleanupUpdates[`${root}/queue/${entry.bucket}/${entry.key}`] = null;
      cleanupUpdates[`${root}/folderQueue/${folderId}/${entry.bucket}/${entry.key}`] = null;
    });
    if (Object.keys(cleanupUpdates).length) {
      await update(ref(db), cleanupUpdates);
    }
  }
  return {
    cards,
    total: cardIds.length,
    hasMore: cardIds.length > limit,
  };
}

export async function fetchCardsForSearch(db, username, folderId = null, limit = 200) {
  const root = userRoot(username);
  const cardsRef = ref(db, `${root}/cards`);
  const cardsQuery = query(cardsRef, orderByChild("createdAt"), limitToFirst(limit));
  const snap = await get(cardsQuery);
  const entries = [];
  if (snap.exists()) {
    snap.forEach((childSnap) => {
      entries.push({ id: childSnap.key, ...childSnap.val() });
    });
  }
  if (folderId) {
    return entries.filter((card) => card.folderId === folderId);
  }
  return entries;
}

export function listenTagsIndex(db, username, callback) {
  const root = userRoot(username);
  return onValue(ref(db, `${root}/tagsIndex`), (snap) => {
    if (!snap.exists()) {
      callback([]);
      return;
    }
    callback(Object.keys(snap.val()));
  });
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
  tagFilterMode = "and",
  allowRepair = false,
  countsOnly = false,
}) {
  const folderId = folderIdOrAll === "all" ? null : folderIdOrAll;
  const root = userRoot(username);
  const cardIds = [];
  const bucketCounts = {};
  const seen = new Set();
  const normalizedTags = tagFilter.map((tag) => tag.toLowerCase());

  if (countsOnly) {
    for (const bucket of buckets) {
      const base = folderId ? `${root}/folderQueue/${folderId}/${bucket}` : `${root}/queue/${bucket}`;
      const bucketSnap = await get(ref(db, base));
      if (!bucketSnap.exists()) {
        bucketCounts[bucket] = 0;
        continue;
      }
      const keys = Object.keys(bucketSnap.val());
      if (!normalizedTags.length) {
        bucketCounts[bucket] = keys.length;
        continue;
      }
      const cardIdsForBucket = keys
        .map((key) => parseQueueCardId(key))
        .filter(Boolean);
      let count = 0;
      const chunkSize = 40;
      for (let i = 0; i < cardIdsForBucket.length; i += chunkSize) {
        const chunk = cardIdsForBucket.slice(i, i + chunkSize);
        const snaps = await Promise.all(chunk.map((cardId) => get(child(ref(db), `${root}/cards/${cardId}`))));
        snaps.forEach((snap) => {
          if (!snap.exists()) return;
          const card = snap.val();
          const cardTags = getCardTags(card);
          const matches = tagFilterMode === "and"
            ? normalizedTags.every((tag) => cardTags.includes(tag))
            : normalizedTags.some((tag) => cardTags.includes(tag));
          if (matches) {
            count += 1;
          }
        });
      }
      bucketCounts[bucket] = count;
    }

    return {
      cardIds,
      bucketCounts,
      fallbackCount: 0,
      usedFallback: false,
      repaired: false,
    };
  }

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
  const filtered = fallbackCards.filter((card) => {
    if (!card) return false;
    const bucket = card.srs?.bucket || "new";
    if (!buckets.includes(bucket)) return false;
    if (folderId && card.folderId !== folderId) return false;
    if (normalizedTags.length) {
      const cardTags = getCardTags(card);
      const matches = tagFilterMode === "and"
        ? normalizedTags.every((tag) => cardTags.includes(tag))
        : normalizedTags.some((tag) => cardTags.includes(tag));
      if (!matches) return false;
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

export async function migrateCardsFolderIdsOnce(db, username, limit = 2000) {
  const root = userRoot(username);
  const foldersSnap = await get(ref(db, `${root}/folders`));
  const foldersMap = foldersSnap.exists() ? foldersSnap.val() : {};
  const folderIdSet = new Set(Object.keys(foldersMap || {}));
  const folderPathMap = {};
  Object.values(foldersMap || {}).forEach((folder) => {
    const normalized = normalizeFolderPath(folder?.path || folder?.name || "");
    if (normalized) {
      folderPathMap[normalized] = folder.id;
    }
  });
  const cardsRef = query(ref(db, `${root}/cards`), orderByKey(), limitToFirst(limit));
  const cardsSnap = await get(cardsRef);
  if (!cardsSnap.exists()) {
    return { scanned: 0, migrated: 0 };
  }
  const updates = {};
  let scanned = 0;
  let migrated = 0;

  const resolveFolderId = async (path) => {
    if (!path) return null;
    if (folderPathMap[path]) return folderPathMap[path];
    const createdId = await getOrCreateFolderByPath(db, username, path, foldersMap);
    if (createdId) {
      folderPathMap[path] = createdId;
    }
    return createdId;
  };

  const updatePromises = [];
  cardsSnap.forEach((childSnap) => {
    scanned += 1;
    const cardId = childSnap.key;
    const card = childSnap.val();
    if (!card || !cardId) return;
    const currentFolderId = card.folderId;
    if (currentFolderId && folderIdSet.has(currentFolderId)) return;
    const candidatePath = normalizeFolderPath(currentFolderId);
    const fallbackPath = normalizeFolderPath(card.folderPath);
    const resolvedPath = candidatePath.includes("/") ? candidatePath : fallbackPath;
    if (!resolvedPath) return;
    updatePromises.push(
      (async () => {
        const folderIdReal = await resolveFolderId(resolvedPath);
        if (!folderIdReal) return;
        updates[`${root}/cards/${cardId}/folderId`] = folderIdReal;
        updates[`${root}/cards/${cardId}/folderPath`] = resolvedPath;
        const srs = card.srs || defaultSrs();
        const bucket = srs.bucket || "new";
        const dueAt = srs.dueAt || card.createdAt || Date.now();
        const key = buildQueueKey(dueAt, cardId);
        if (currentFolderId) {
          updates[`${root}/folderQueue/${currentFolderId}/${bucket}/${key}`] = null;
        }
        updates[`${root}/folderQueue/${folderIdReal}/${bucket}/${key}`] = true;
        migrated += 1;
      })()
    );
  });
  if (updatePromises.length) {
    await Promise.all(updatePromises);
  }
  if (Object.keys(updates).length) {
    await update(ref(db), updates);
  }
  return { scanned, migrated };
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

export async function fetchFolders(db, username) {
  const root = userRoot(username);
  const snap = await get(ref(db, `${root}/folders`));
  return snap.exists() ? snap.val() : {};
}

export async function fetchSampleCards(db, username, limit = 5) {
  const root = userRoot(username);
  const cardsRef = query(ref(db, `${root}/cards`), orderByKey(), limitToFirst(limit));
  const snap = await get(cardsRef);
  const cards = [];
  if (snap.exists()) {
    snap.forEach((childSnap) => {
      cards.push({ id: childSnap.key, ...childSnap.val() });
    });
  }
  return cards;
}

export async function fetchGlossaryWord(db, username, wordKey) {
  const root = userRoot(username);
  const snap = await get(child(ref(db), `${root}/glossary/${wordKey}`));
  return snap.exists() ? snap.val() : null;
}

export async function upsertGlossaryEntries(db, username, entries) {
  const root = userRoot(username);
  const updates = {};
  entries.forEach((entry) => {
    updates[`${root}/glossary/${entry.key}`] = {
      w: entry.word,
      wn: normalizeText(entry.word),
      m: entry.meaning,
      tags: entry.tags || {},
      updatedAt: Date.now(),
    };
  });
  await update(ref(db), updates);
}

export async function migrateDedupeV2Once(db, username) {
  const root = userRoot(username);
  const foldersSnap = await get(ref(db, `${root}/folders`));
  const foldersMap = foldersSnap.exists() ? foldersSnap.val() : {};
  const folderIds = Object.keys(foldersMap || {});
  let migrated = 0;
  let removed = 0;
  let scanned = 0;

  const migrateSide = async (folderId, side) => {
    const node = side === "front" ? "dedupeFront" : "dedupeBack";
    const snap = await get(ref(db, `${root}/${node}/${folderId}`));
    if (!snap.exists()) return;
    const updates = {};
    const migratePromises = [];
    snap.forEach((childSnap) => {
      const key = childSnap.key;
      const value = childSnap.val();
      scanned += 1;
      const isLegacyKey = key.includes("%") || key.length > 40;
      const isLegacyValue = typeof value === "string" || !value?.cardId || !value?.norm;
      if (!isLegacyKey && !isLegacyValue) {
        return;
      }
      const cardId = typeof value === "string" ? value : value?.cardId;
      if (!cardId) {
        updates[`${root}/${node}/${folderId}/${key}`] = null;
        removed += 1;
        return;
      }
      migratePromises.push(
        (async () => {
          const cardSnap = await get(child(ref(db), `${root}/cards/${cardId}`));
          if (!cardSnap.exists()) {
            updates[`${root}/${node}/${folderId}/${key}`] = null;
            removed += 1;
            return;
          }
          const card = cardSnap.val();
          const dedupe = await buildCardDedupe(card);
          const hash = side === "front" ? dedupe.frontHash : dedupe.backHash;
          const norm = side === "front" ? dedupe.normFront : dedupe.normBack;
          if (!hash || !norm) {
            updates[`${root}/${node}/${folderId}/${key}`] = null;
            removed += 1;
            return;
          }
          updates[`${root}/${node}/${folderId}/${hash}`] = { cardId, norm };
          updates[`${root}/${node}/${folderId}/${key}`] = null;
          migrated += 1;
        })()
      );
    });
    if (migratePromises.length) {
      await Promise.all(migratePromises);
    }
    if (Object.keys(updates).length) {
      await update(ref(db), updates);
    }
  };

  for (const folderId of folderIds) {
    await migrateSide(folderId, "front");
    await migrateSide(folderId, "back");
  }

  return {
    scanned,
    migrated,
    removed,
  };
}

export async function ensureVocabFolders(db, username, existingFolders = {}) {
  const requiredPaths = {
    deEs: "Alemán/Vocabulario/General/DE-ES",
    esDe: "Alemán/Vocabulario/General/ES-DE",
  };
  const result = {};
  for (const [key, path] of Object.entries(requiredPaths)) {
    result[key] = await getOrCreateFolderByPath(db, username, path, existingFolders);
  }
  return result;
}

export async function createOrUpdateVocabCard(db, username, { folderId, front, back, tags = [] }) {
  if (!folderId || !front || !back) return null;
  const normalizedTags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const id = `vocab_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  return upsertCardWithDedupe(db, username, {
    id,
    folderId,
    type: "basic",
    front,
    back,
    tags: tagsToMap(normalizedTags),
  });
}
