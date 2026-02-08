export function setActiveScreenRoute({ name, screens, tabs, setReviewMode, onFoldersMount, onCardsMount, onReviewMount }) {
  const tabName = name === "cards" ? "folders" : name;
  (screens || []).forEach((screen) => {
    screen.classList.toggle("active", screen.id === `screen-${name}`);
  });
  (tabs || []).forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.screen === tabName);
  });
  if (name !== "review") {
    setReviewMode?.(false);
  }
  if (name === "folders") onFoldersMount?.();
  if (name === "cards") onCardsMount?.();
  if (name === "review") onReviewMount?.();
}
