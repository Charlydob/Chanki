import { ensureDeviceId } from "../lib/firebase.js";

export const BUCKET_ORDER = ["new", "immediate", "lt24h", "tomorrow", "week", "future"];
export const BUCKET_LABELS = {
  new: "Nvo",
  immediate: "Ahora",
  lt24h: "<24h",
  tomorrow: "Mañana",
  week: "<1sem",
  future: "Futuro",
};
export const BUCKET_ALIASES = {
  new: "new",
  nvo: "new",
  nuevo: "new",
  immediate: "immediate",
  ahora: "immediate",
  lt24h: "lt24h",
  "<24h": "lt24h",
  "24h": "lt24h",
  tomorrow: "tomorrow",
  "mañana": "tomorrow",
  manana: "tomorrow",
  week: "week",
  "<1sem": "week",
  "1sem": "week",
  semana: "week",
  future: "future",
  futuro: "future",
};

export const state = {
  username: localStorage.getItem("chanki_username") || "",
  deviceId: ensureDeviceId(),
  folders: {},
  selectedFolderId: null,
  activeFolderRef: null,
  cards: [],
  cardsCache: [],
  cardsPageCursor: null,
  cardsHasMore: true,
  cardsLoadMode: "paged",
  cardsLoadingMore: false,
  cardsSearchQuery: "",
  cardsSearchPool: [],
  cardsSearchFolderId: null,
  cardsSearchOwnerUid: null,
  cardsSearchLoading: false,
  cardsLoadedIds: new Set(),
  cardCache: new Map(),
  glossaryCache: new Map(),
  lexicon: {},
  reviewQueue: [],
  currentSessionQueue: [],
  currentIndex: 0,
  sessionActive: false,
  sessionTotal: 0,
  showOnlyDuplicates: false,
  cardsSelectionMode: false,
  selectedCardIds: new Set(),
  allCards: [],
  allCardsSelectedIds: new Set(),
  allCardsCollapsedGroups: new Set(),
  sessionEnding: false,
  sessionStats: {
    startTime: null,
    answeredCount: 0,
  },
  sessionStart: null,
  lastReviewAt: null,
  bucketCounts: {},
  reviewBucketCounts: {},
  reviewBuckets: {
    new: true,
    immediate: true,
    lt24h: true,
    tomorrow: true,
    week: true,
    future: true,
  },
  prefs: {
    maxNew: Number(localStorage.getItem("chanki_max_new")) || 10,
    maxReviews: Number(localStorage.getItem("chanki_max_reviews")) || 50,
    clozeCaseInsensitive: localStorage.getItem("chanki_cloze_case") !== "false",
    orderAnswerLines: Number(localStorage.getItem("chanki_order_lines")) || 2,
  },
  reviewClozeAnswers: [],
  reviewOrder: null,
  activeWordKey: null,
  activeWordNorm: null,
  activeWordContext: null,
  reviewFolderName: "Todas",
  reviewFolderOwnerUid: null,
  reviewFolderRole: null,
  reviewFolderIsShared: false,
  reviewSelectedFolderIds: [],
  reviewFolderSearchQuery: "",
  reviewExcludeTags: new Set(),
  reviewTagFilterMode: localStorage.getItem("chanki_review_include_mode") || "or",
  reviewFilterVisibleCount: 0,
  reviewShowingBack: false,
  repairAttempted: false,
  vocabFolderIds: {
    deEs: null,
    esDe: null,
  },
  vocabFoldersPromise: null,
  allTags: [],
  selectedTags: new Set(),
  reviewSelectedTags: new Set(),
  folderCardCounts: {},
  sharedFolders: {},
  sharedFolderRefs: {},
  usersPublic: {},
  folderBrowseId: null,
  movingFolderId: null,
  folderSelectionMode: false,
  selectedFolderIds: new Set(),
};

export const elements = {
  status: document.getElementById("status"),
  app: document.getElementById("app"),
  screens: document.querySelectorAll(".screen"),
  tabs: document.querySelectorAll(".tab"),
  overlay: document.getElementById("overlay"),
  usernameInput: document.getElementById("username-input"),
  saveUsername: document.getElementById("save-username"),
  folderTree: document.getElementById("folder-tree"),
  addFolder: document.getElementById("add-folder"),
  addCardFromFolders: document.getElementById("add-card-from-folders"),
  addSubfolder: document.getElementById("add-subfolder"),
  folderSelectToggle: document.getElementById("folder-select-toggle"),
  folderBulkBar: document.getElementById("folder-bulk-bar"),
  folderSelectedCount: document.getElementById("folder-selected-count"),
  folderBulkMove: document.getElementById("folder-bulk-move"),
  folderBulkGroup: document.getElementById("folder-bulk-group"),
  folderBulkCancel: document.getElementById("folder-bulk-cancel"),
  foldersBreadcrumb: document.getElementById("folders-breadcrumb"),
  folderMoveModal: document.getElementById("folder-move-modal"),
  folderMoveTargetList: document.getElementById("folder-move-target-list"),
  folderMoveCancel: document.getElementById("folder-move-cancel"),
  folderGroupModal: document.getElementById("folder-group-modal"),
  folderGroupName: document.getElementById("folder-group-name"),
  folderGroupConfirm: document.getElementById("folder-group-confirm"),
  folderGroupCancel: document.getElementById("folder-group-cancel"),
  cardsList: document.getElementById("cards-list"),
  addCard: document.getElementById("add-card"),
  loadMore: document.getElementById("load-more"),
  cardModal: document.getElementById("card-modal"),
  cardModalTitle: document.getElementById("card-modal-title"),
  cardModalClose: document.getElementById("card-modal-close"),
  cardFolderField: document.getElementById("card-folder-field"),
  cardFolderSelect: document.getElementById("card-folder-select"),
  cardFolderEmptyMessage: document.getElementById("card-folder-empty-message"),
  cardType: document.getElementById("card-type"),
  cardFront: document.getElementById("card-front"),
  cardBack: document.getElementById("card-back"),
  cardGrammarType: document.getElementById("card-grammar-type"),
  cardVerbToolsField: document.getElementById("card-verb-tools-field"),
  cardVerbReversoLink: document.getElementById("card-verb-reverso-link"),
  cardVerbPasteField: document.getElementById("card-verb-paste-field"),
  cardVerbPaste: document.getElementById("card-verb-paste"),
  cardNounToolsField: document.getElementById("card-noun-tools-field"),
  cardNounGenderField: document.getElementById("card-noun-gender-field"),
  cardNounGender: document.getElementById("card-noun-gender"),
  cardFrontLabel: document.getElementById("card-front-label"),
  cardBackLabel: document.getElementById("card-back-label"),
  cardTranslate: document.getElementById("card-translate"),
  cardTranslateEsDe: document.getElementById("card-translate-es-de"),
  cardTranslateDeEs: document.getElementById("card-translate-de-es"),
  cardTranslateStatus: document.getElementById("card-translate-status"),
  cardTranslateContextField: document.getElementById("card-translate-context-field"),
  cardTranslateContext: document.getElementById("card-translate-context"),
  cardClozeText: document.getElementById("card-cloze-text"),
  cardClozeAnswers: document.getElementById("card-cloze-answers"),
  cardOrderTokens: document.getElementById("card-order-tokens"),
  cardOrderLabels: document.getElementById("card-order-labels"),
  cardOrderAnswer: document.getElementById("card-order-answer"),
  cardBasicFrontField: document.getElementById("card-basic-front-field"),
  cardBasicBackField: document.getElementById("card-basic-back-field"),
  cardClozeTextField: document.getElementById("card-cloze-text-field"),
  cardClozeAnswersField: document.getElementById("card-cloze-answers-field"),
  cardOrderTokensField: document.getElementById("card-order-tokens-field"),
  cardOrderLabelsField: document.getElementById("card-order-labels-field"),
  cardOrderAnswerField: document.getElementById("card-order-answer-field"),
  cardOrderHelp: document.getElementById("card-order-help"),
  cardTags: document.getElementById("card-tags"),
  saveCard: document.getElementById("save-card"),
  cancelCard: document.getElementById("cancel-card"),
  cardsTitle: document.getElementById("cards-title"),
  cardsFolderMeta: document.getElementById("cards-folder-meta"),
  backToFolders: document.getElementById("back-to-folders"),
  cardsDupCount: document.getElementById("cards-dup-count"),
  cardsDupToggle: document.getElementById("cards-dup-toggle"),
  screenReviewConfig: document.getElementById("screen-review-config"),
  screenReviewPlayer: document.getElementById("screen-review-player"),
  reviewFolderTrigger: document.getElementById("review-folder-trigger"),
  reviewFolderLabel: document.getElementById("review-folder-label"),
  reviewFolderModal: document.getElementById("review-folder-modal"),
  reviewFolderOptions: document.getElementById("review-folder-options"),
  reviewFolderSearch: document.getElementById("review-folder-search"),
  reviewFolderApply: document.getElementById("review-folder-apply"),
  reviewFolderClose: document.getElementById("review-folder-close"),
  reviewBucketChart: document.getElementById("review-bucket-chart"),
  reviewTags: document.getElementById("review-tags"),
  reviewTagsExclude: document.getElementById("review-tags-exclude"),
  reviewFilterSummary: document.getElementById("review-filter-summary"),
  reviewFolderSelectAll: document.getElementById("review-folder-select-all"),
  reviewFolderSelectNone: document.getElementById("review-folder-select-none"),
  reviewFolderResetPreferences: document.getElementById("review-folder-reset-preferences"),
  reviewMaxNew: document.getElementById("review-max-new"),
  reviewMax: document.getElementById("review-max"),
  startReview: document.getElementById("start-review"),
  reviewCard: document.getElementById("review-card"),
  flipCard: document.getElementById("flip-card"),
  reviewActions: document.getElementById("review-actions"),
  reviewExit: document.getElementById("review-exit"),
  reviewPlayerFolder: document.getElementById("review-player-folder"),
  reviewPlayerCounter: document.getElementById("review-player-counter"),
  reviewPlayerBucket: document.getElementById("review-player-bucket"),
  reviewEditCard: document.getElementById("review-edit-card"),
  importFolder: document.getElementById("import-folder"),
  importFolderSelect: document.getElementById("import-folder-select"),
  importText: document.getElementById("import-text"),
  importPreview: document.getElementById("import-preview"),
  importParse: document.getElementById("import-parse"),
  importSave: document.getElementById("import-save"),
  importCancel: document.getElementById("import-cancel"),
  importContext: document.getElementById("import-context"),
  importDestination: document.getElementById("import-destination"),
  importWarning: document.getElementById("import-warning"),
  statsTodayCount: document.getElementById("stats-today-count"),
  statsTodayMinutes: document.getElementById("stats-today-minutes"),
  statsTodayAccuracy: document.getElementById("stats-today-accuracy"),
  statsTodayDistribution: document.getElementById("stats-today-distribution"),
  statsWeekTotal: document.getElementById("stats-week-total"),
  statsWeekMinutes: document.getElementById("stats-week-minutes"),
  statsWeekAverage: document.getElementById("stats-week-average"),
  statsWeekChart: document.getElementById("stats-week-chart"),
  statsMonthTotal: document.getElementById("stats-month-total"),
  statsMonthAverage: document.getElementById("stats-month-average"),
  statsMonthBest: document.getElementById("stats-month-best"),
  statsMonthCompare: document.getElementById("stats-month-compare"),
  statsHeatmap: document.getElementById("stats-heatmap"),
  statsHeatmapTooltip: document.getElementById("stats-heatmap-tooltip"),
  statsMonthChart: document.getElementById("stats-month-chart"),
  statsMonthDonut: document.getElementById("stats-month-donut"),
  statsMonthLegend: document.getElementById("stats-month-legend"),
  statsStreakCurrent: document.getElementById("stats-streak-current"),
  statsStreakBest: document.getElementById("stats-streak-best"),
  statsTotalCards: document.getElementById("stats-total-cards"),
  statsTotalNew: document.getElementById("stats-total-new"),
  statsTotalLearned: document.getElementById("stats-total-learned"),
  statsBucketCounts: document.getElementById("stats-bucket-counts"),
  dailyDate: document.getElementById("daily-date"),
  dailyContent: document.getElementById("daily-content"),
  settingsUsername: document.getElementById("settings-username"),
  settingsMaxNew: document.getElementById("settings-max-new"),
  settingsMax: document.getElementById("settings-max"),
  settingsClozeCase: document.getElementById("settings-cloze-case"),
  settingsThemeDark: document.getElementById("settings-theme-dark"),
  saveSettings: document.getElementById("save-settings"),
  exportJson: document.getElementById("export-json"),
  resetLocal: document.getElementById("reset-local"),
  folderModal: document.getElementById("folder-modal"),
  folderModalTitle: document.getElementById("folder-modal-title"),
  folderNameInput: document.getElementById("folder-name-input"),
  folderEmojiInput: document.getElementById("folder-emoji-input"),
  folderColorInput: document.getElementById("folder-color-input"),
  folderBothSidesInput: document.getElementById("folder-both-sides-input"),
  folderSourceLang: document.getElementById("folder-source-lang"),
  folderTargetLang: document.getElementById("folder-target-lang"),
  saveFolder: document.getElementById("save-folder"),
  cancelFolder: document.getElementById("cancel-folder"),
  cardsSelectToggle: document.getElementById("cards-select-toggle"),
  cardsBulkMove: document.getElementById("cards-bulk-move"),
  cardsBulkClearFolder: document.getElementById("cards-bulk-clear-folder"),
  cardsBulkDelete: document.getElementById("cards-bulk-delete"),
  allCardsList: document.getElementById("all-cards-list"),
  allCardsSelectedCount: document.getElementById("all-cards-selected-count"),
  allCardsBulkBar: document.getElementById("all-cards-bulk-bar"),
  allCardsSelectAll: document.getElementById("all-cards-select-all"),
  allCardsClearAll: document.getElementById("all-cards-clear-all"),
  allCardsMoveTarget: document.getElementById("all-cards-move-target"),
  allCardsMove: document.getElementById("all-cards-move"),
  allCardsDelete: document.getElementById("all-cards-delete"),
  shareModal: document.getElementById("share-modal"),
  shareFolderTitle: document.getElementById("share-folder-title"),
  shareUserSearch: document.getElementById("share-user-search"),
  shareRoleToggle: document.getElementById("share-role-toggle"),
  shareResults: document.getElementById("share-results"),
  shareCurrentList: document.getElementById("share-current-list"),
  shareClose: document.getElementById("share-close"),
  toastContainer: document.getElementById("toast-container"),
  cardsSearchInput: document.getElementById("cards-search-input"),
  cardsSearchClear: document.getElementById("cards-search-clear"),
};

export function resolveFolderSelection(value) {
  if (!value || value === "all") {
    return {
      ownerUid: state.username,
      folderId: null,
      isShared: false,
      role: null,
      shareKey: null,
    };
  }
  if (value.startsWith("shared:")) {
    const shareKey = value.replace("shared:", "");
    const shared = state.sharedFolders?.[shareKey];
    if (shared) {
      return {
        ownerUid: shared.ownerUid,
        folderId: shared.folderId,
        isShared: true,
        role: shared.role || "viewer",
        shareKey,
      };
    }
  }
  return {
    ownerUid: state.username,
    folderId: value,
    isShared: false,
    role: "owner",
    shareKey: null,
  };
}

export function getReviewFolderSelections() {
  const selected = state.reviewSelectedFolderIds || [];
  if (!selected.length) {
    return [resolveFolderSelection("all")];
  }
  return selected.map((value) => resolveFolderSelection(value));
}

export function canonicalizeBucketId(bucket) {
  if (!bucket) return null;
  const normalized = String(bucket).trim().toLowerCase();
  return BUCKET_ALIASES[normalized] || (BUCKET_ORDER.includes(normalized) ? normalized : null);
}

export function normalizeTags(text) {
  return text
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

export function dedupeTags(list) {
  return [...new Set(list.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}


export function getReviewTagFilters() {
  return {
    includeTags: dedupeTags([
      ...state.reviewSelectedTags,
      ...normalizeTags(elements.reviewTags?.value || ""),
    ]),
    excludeTags: dedupeTags([
      ...state.reviewExcludeTags,
      ...normalizeTags(elements.reviewTagsExclude?.value || ""),
    ]),
  };
}

export function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.?!…]+$/g, "");
}

export function normalizeSearchQuery(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
