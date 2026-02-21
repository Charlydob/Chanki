import {
  BUCKET_ORDER,
  canonicalizeBucketId,
  elements,
  getReviewTagFilters,
  state,
} from "../shared.js";
import { getReviewCandidates, loadReviewCards } from "../review-candidates.js";

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
  const { includeTags, excludeTags } = getReviewTagFilters();
  const selectedBuckets = Object.entries(state.reviewBuckets)
    .filter(([, active]) => active)
    .map(([bucket]) => canonicalizeBucketId(bucket))
    .filter(Boolean);
  const normalizedState = {
    ...state,
    reviewIncludeTags: includeTags,
    reviewExcludeTagsList: excludeTags,
    selectedBuckets,
  };
  const cards = await loadReviewCards(state);
  const { candidates } = getReviewCandidates(normalizedState, cards, state.folders || {});
  const combinedCounts = BUCKET_ORDER.reduce((acc, bucket) => {
    acc[bucket] = 0;
    return acc;
  }, {});
  candidates.forEach((card) => {
    const bucket = canonicalizeBucketId(card.srs?.bucket) || "new";
    combinedCounts[bucket] = (combinedCounts[bucket] || 0) + 1;
  });
  state.reviewBucketCounts = combinedCounts;
  state.reviewFilterVisibleCount = Object.values(combinedCounts).reduce((sum, value) => sum + value, 0);
  if (elements.reviewFilterSummary) {
    elements.reviewFilterSummary.textContent = state.reviewFilterVisibleCount
      ? `Tarjetas visibles: ${state.reviewFilterVisibleCount}`
      : "Sin resultados con el filtro actual.";
  }
  if (elements.startReview) {
    elements.startReview.disabled = state.reviewFilterVisibleCount === 0;
  }
  renderBucketFilterCounts(state.reviewBucketCounts);
}
