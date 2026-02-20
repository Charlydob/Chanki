import { getDb } from "../../lib/firebase.js";
import { buildSessionQueue } from "../../lib/rtdb.js";
import {
  BUCKET_ORDER,
  elements,
  getReviewFolderSelections,
  getReviewTagFilters,
  state,
} from "../shared.js";

export function renderBucketFilterCounts(bucketCounts) {
  const values = BUCKET_ORDER.map((bucket) => bucketCounts[bucket] || 0);
  const maxVal = Math.max(1, ...values);
  BUCKET_ORDER.forEach((bucket) => {
    const count = bucketCounts[bucket] || 0;
    const el = document.querySelector(`[data-bucket-count="${bucket}"]`);
    if (el) {
      el.textContent = count;
      const bar = el.closest(".bucket-bar");
      const fill = bar?.querySelector(".bucket-bar__fill");
      if (fill) {
        fill.style.setProperty("--fill", (count / maxVal).toFixed(3));
      }
    }
  });
}

export async function refreshReviewBucketCounts() {
  if (!state.username || !elements.reviewBucketChart) return;
  const db = getDb();
  const { includeTags, excludeTags } = getReviewTagFilters();
  const selections = getReviewFolderSelections();
  const combinedCounts = BUCKET_ORDER.reduce((acc, bucket) => {
    acc[bucket] = 0;
    return acc;
  }, {});
  for (const selection of selections) {
    const result = await buildSessionQueue({
      db,
      username: selection.ownerUid,
      folderIdOrAll: selection.folderId ?? "all",
      buckets: BUCKET_ORDER,
      maxCards: 0,
      tagFilter: includeTags,
      excludeTags,
      tagFilterMode: state.reviewTagFilterMode || "or",
      countsOnly: true,
    });
    BUCKET_ORDER.forEach((bucket) => {
      combinedCounts[bucket] += result.bucketCounts?.[bucket] || 0;
    });
  }
  state.reviewBucketCounts = combinedCounts;
  state.reviewFilterVisibleCount = Object.values(combinedCounts).reduce((sum, value) => sum + value, 0);
  if (elements.reviewFilterSummary) {
    elements.reviewFilterSummary.textContent = state.reviewFilterVisibleCount
      ? `Tarjetas visibles: ${state.reviewFilterVisibleCount}`
      : "Sin resultados con el filtro actual.";
  }
  renderBucketFilterCounts(state.reviewBucketCounts);
}
