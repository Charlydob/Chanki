import { getDb } from "../../lib/firebase.js";
import { buildSessionQueue } from "../../lib/rtdb.js";
import {
  BUCKET_ORDER,
  dedupeTags,
  elements,
  getReviewFolderSelections,
  normalizeTags,
  state,
} from "../shared.js";

// moved from app.js
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

// moved from app.js
export async function refreshReviewBucketCounts() {
  if (!state.username || !elements.reviewBucketChart) return;
  const db = getDb();
  const tagFilter = dedupeTags([
    ...state.reviewSelectedTags,
    ...normalizeTags(elements.reviewTags.value),
  ]);
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
      tagFilter,
      tagFilterMode: "or",
      countsOnly: true,
    });
    BUCKET_ORDER.forEach((bucket) => {
      combinedCounts[bucket] += result.bucketCounts?.[bucket] || 0;
    });
  }
  state.reviewBucketCounts = combinedCounts;
  renderBucketFilterCounts(state.reviewBucketCounts);
}
