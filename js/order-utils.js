export function normalizeOrderTokens(card) {
  const tokens = card.orderTokens || [];
  return tokens.map((token, index) => ({
    id: token?.id || `t${index}`,
    text: token?.text || "",
    label: token?.label || "",
    originalIndex: index,
  }));
}

export function buildOrderState(card) {
  const tokens = normalizeOrderTokens(card);
  const tokenIds = tokens.map((token) => token.id);
  const tokenMap = tokens.reduce((acc, token) => {
    acc[token.id] = token;
    return acc;
  }, {});
  const answerIds = (card.orderAnswer || []).filter((id) => tokenMap[id]);
  const resolvedAnswer = answerIds.length === tokens.length ? answerIds : tokenIds;
  return {
    cardId: card.id,
    tokens,
    tokenMap,
    bank: [...tokenIds],
    selected: [],
    answer: resolvedAnswer,
  };
}

export function resetOrderState(orderState) {
  orderState.bank = [...orderState.tokens.map((token) => token.id)];
  orderState.selected = [];
}

export function insertOrderToken(orderState, tokenId) {
  const token = orderState.tokenMap[tokenId];
  if (!token) return;
  const insertIndex = orderState.bank.findIndex((id) => {
    const candidate = orderState.tokenMap[id];
    return candidate && candidate.originalIndex > token.originalIndex;
  });
  if (insertIndex === -1) {
    orderState.bank.push(tokenId);
    return;
  }
  orderState.bank.splice(insertIndex, 0, tokenId);
}

export function moveOrderToken(orderState, tokenId, destination) {
  if (!tokenId || !orderState.tokenMap[tokenId]) return;
  const selectedIndex = orderState.selected.indexOf(tokenId);
  if (selectedIndex !== -1) {
    orderState.selected.splice(selectedIndex, 1);
  }
  const bankIndex = orderState.bank.indexOf(tokenId);
  if (bankIndex !== -1) {
    orderState.bank.splice(bankIndex, 1);
  }
  if (destination === "selected") {
    orderState.selected.push(tokenId);
  } else {
    insertOrderToken(orderState, tokenId);
  }
}

export function moveSelected(orderState, fromIndex, toIndex) {
  const selected = orderState.selected;
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= selected.length ||
    toIndex < 0 ||
    toIndex > selected.length
  )
    return;
  const [tokenId] = selected.splice(fromIndex, 1);
  const clampedIndex = Math.min(Math.max(toIndex, 0), selected.length);
  selected.splice(clampedIndex, 0, tokenId);
}

export function insertFromAvailable(orderState, tokenId, toIndex) {
  if (!tokenId || !orderState.tokenMap[tokenId]) return;
  const bankIndex = orderState.bank.indexOf(tokenId);
  if (bankIndex === -1) return;
  orderState.bank.splice(bankIndex, 1);
  const clampedIndex = Math.min(Math.max(toIndex, 0), orderState.selected.length);
  orderState.selected.splice(clampedIndex, 0, tokenId);
}

export function evaluateOrderState(orderState) {
  const expected = orderState.answer || [];
  const selected = orderState.selected || [];
  const results = expected.map((id, index) => selected[index] === id);
  const filled = selected.length === expected.length;
  const correct = filled && results.every(Boolean);
  return { correct, results, filled };
}

export function shouldShowOrderSolution(evaluation) {
  return Boolean(evaluation && !evaluation.correct);
}

export function buildOrderSolution(orderState, evaluation) {
  const answerIds = orderState.answer || [];
  return answerIds.map((id, index) => ({
    token: orderState.tokenMap[id],
    isCorrectPosition: evaluation ? evaluation.results[index] === true : false,
  }));
}
