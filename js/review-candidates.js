import { getDb } from "../lib/firebase.js";
import { fetchCardsForSearch } from "../lib/rtdb.js";
import { classifySrsBucket, normalizeSrs } from "../lib/srs.js";
import { BUCKET_ORDER, canonicalizeBucketId, getReviewFolderSelections } from "./shared.js";

function mapToTags(tagsMap) {
  return Object.keys(tagsMap || {}).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
}

function normalizeList(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

function cardMatchesInclude(cardTags, includeTags) {
  if (!includeTags.length) return true;
  return includeTags.some((tag) => cardTags.includes(tag));
}

function cardMatchesExclude(cardTags, excludeTags) {
  if (!excludeTags.length) return false;
  return excludeTags.some((tag) => cardTags.includes(tag));
}

function resolveFolderMode(state, folders) {
  const selectedIds = (state.reviewSelectedFolderIds || []).filter(Boolean);
  const validSelected = selectedIds.filter((id) => id.startsWith("shared:") || folders?.[id]);
  if (!validSelected.length) {
    return { mode: "all", selectedFolderId: null, reviewFolderIds: [] };
  }
  if (validSelected.length === 1) {
    return { mode: "single", selectedFolderId: validSelected[0], reviewFolderIds: validSelected };
  }
  return { mode: "multi", selectedFolderId: null, reviewFolderIds: validSelected };
}

export function getReviewCandidates(state, cards, folders) {
  const includeTags = normalizeList(state.reviewIncludeTags || []);
  const excludeTags = normalizeList(state.reviewExcludeTagsList || []);
  const selectedBucketsInput = (state.selectedBuckets || []).map((bucket) => canonicalizeBucketId(bucket)).filter(Boolean);
  const selectedBuckets = selectedBucketsInput.length ? selectedBucketsInput : [...BUCKET_ORDER];
  const folderState = resolveFolderMode(state, folders);
  const reductions = [];

  const withFolder = cards.filter((card) => {
    const cardFolderId = card.folderId || null;
    const cardShareKey = card._reviewShareKey || null;
    if (folderState.mode === "all") return true;
    if (folderState.mode === "single") {
      if (folderState.selectedFolderId?.startsWith("shared:")) {
        return cardShareKey === folderState.selectedFolderId.replace("shared:", "");
      }
      return cardFolderId === folderState.selectedFolderId;
    }
    return folderState.reviewFolderIds.some((folderId) => {
      if (folderId.startsWith("shared:")) {
        return cardShareKey === folderId.replace("shared:", "");
      }
      return cardFolderId === folderId;
    });
  });
  reductions.push({ filter: `folder=${folderState.mode}`, before: cards.length, after: withFolder.length });

  const withInclude = withFolder.filter((card) => cardMatchesInclude(mapToTags(card.tags), includeTags));
  reductions.push({ filter: `includeTags=${includeTags.length ? includeTags.join(",") : "all"}`, before: withFolder.length, after: withInclude.length });

  const withoutExclude = withInclude.filter((card) => !cardMatchesExclude(mapToTags(card.tags), excludeTags));
  reductions.push({ filter: `excludeTags=${excludeTags.length ? excludeTags.join(",") : "none"}`, before: withInclude.length, after: withoutExclude.length });

  const now = Date.now();
  const classifiedCards = withoutExclude.map((card) => {
    const srs = normalizeSrs(card.srs, card.createdAt);
    const bucket = classifySrsBucket(srs, now);
    const classified = {
      ...card,
      srs: {
        ...srs,
        bucket,
      },
    };
    console.debug("[chanki:buckets:card-classified]", {
      cardId: card.id,
      bucket,
      reviewCount: classified.srs.reviewCount,
      lastReviewedAt: classified.srs.lastReviewedAt || null,
      nextReviewAt: classified.srs.nextReviewAt || null,
    });
    return classified;
  });
  reductions.push({ filter: "classified=srs", before: withoutExclude.length, after: classifiedCards.length });

  const bucketCounts = BUCKET_ORDER.reduce((acc, bucket) => {
    acc[bucket] = 0;
    return acc;
  }, {});
  classifiedCards.forEach((card) => {
    const bucket = canonicalizeBucketId(card.srs?.bucket) || "new";
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
  });
  console.debug("[chanki:buckets:summary]", {
    counts: bucketCounts,
    total: classifiedCards.length,
    selectedBuckets,
  });

  const candidates = classifiedCards.filter((card) => {
    const bucket = canonicalizeBucketId(card.srs?.bucket) || "new";
    return selectedBuckets.includes(bucket);
  });
  reductions.push({ filter: `buckets=${selectedBuckets.join(",")}`, before: classifiedCards.length, after: candidates.length });

  return {
    candidates,
    bucketCounts,
    classifiedCards,
    debug: {
      totalCardsLoaded: cards.length,
      folderMode: folderState.mode,
      selectedFolderId: folderState.selectedFolderId,
      reviewFolderIds: folderState.reviewFolderIds,
      includeTags,
      excludeTags,
      selectedBuckets,
      candidatesCount: candidates.length,
      reductions,
      sampleCandidates: candidates.slice(0, 3).map((card) => ({
        id: card.id,
        folderId: card.folderId || null,
        tags: mapToTags(card.tags),
        bucketInfo: canonicalizeBucketId(card.srs?.bucket) || "new",
        nextReviewAt: card.srs?.nextReviewAt || card.srs?.dueAt || null,
      })),
    },
  };
}

export async function loadReviewCards(state) {
  const db = getDb();
  const selections = getReviewFolderSelections();
  const seen = new Set();
  const cards = [];
  for (const selection of selections) {
    const selectionCards = await fetchCardsForSearch(db, selection.ownerUid, selection.folderId || null, 5000);
    selectionCards.forEach((card) => {
      const key = `${selection.ownerUid}:${card.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      cards.push({
        ...card,
        folderId: card.folderId || null,
        _reviewOwnerUid: selection.ownerUid,
        _reviewRole: selection.role,
        _reviewIsShared: selection.isShared,
        _reviewShareKey: selection.shareKey,
      });
    });
  }
  return cards;
}
