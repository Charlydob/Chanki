function unescapeDoubleColon(text) {
  return text.replace(/\\::/g, "::");
}

function normalizeFieldValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDelimitedList(value) {
  return String(value || "")
    .split(/\s*\|\s*/)
    .map((entry) => normalizeFieldValue(entry))
    .filter(Boolean);
}

function extractLanguageSegment(text, code) {
  const normalized = normalizeFieldValue(text || "");
  if (!normalized) return "";
  const regex = new RegExp(`${code}\\s*:\\s*`, "i");
  const match = normalized.match(regex);
  if (!match || match.index === undefined) return "";
  const startIndex = match.index + match[0].length;
  const rest = normalized.slice(startIndex).trim();
  if (!rest) return "";
  const nextMatch = rest.match(/\b[A-Z]{2}\s*:/);
  if (nextMatch && nextMatch.index !== undefined) {
    return normalizeFieldValue(rest.slice(0, nextMatch.index));
  }
  return normalizeFieldValue(rest);
}

function parseLegacyOrderTokens(front) {
  const normalized = normalizeFieldValue(front || "");
  if (!/^order\s*:/i.test(normalized)) return [];
  const tokenSection = normalized.replace(/^order\s*:\s*/i, "");
  return tokenSection
    .split("|")
    .map((token) => normalizeFieldValue(token))
    .filter(Boolean);
}

function guessLegacyOrderAnswer(tokens, phrase) {
  const normalizedPhrase = normalizeFieldValue(phrase || "").toLowerCase();
  if (!normalizedPhrase) return null;
  const positions = tokens.map((token) => {
    const text = normalizeFieldValue(token.text).toLowerCase();
    return { id: token.id, index: normalizedPhrase.indexOf(text) };
  });
  if (positions.some((entry) => entry.index === -1)) return null;
  const uniquePositions = new Set(positions.map((entry) => entry.index));
  if (uniquePositions.size !== positions.length) return null;
  return positions.sort((a, b) => a.index - b.index).map((entry) => entry.id);
}

function buildLegacyOrderCardPayload(front, back) {
  const tokenTexts = parseLegacyOrderTokens(front);
  if (!tokenTexts.length) return null;
  const tokens = tokenTexts.map((text, index) => ({
    id: `t${index}`,
    text,
    label: "—",
  }));
  const spanish = extractLanguageSegment(back, "ES") || normalizeFieldValue(back || "");
  const german = extractLanguageSegment(back, "DE");
  const guessedAnswer = guessLegacyOrderAnswer(tokens, german);
  const answer = guessedAnswer || tokens.map((token) => token.id);
  const legacyFallback = !guessedAnswer;
  return {
    type: "order",
    front: spanish,
    orderTokens: tokens,
    orderAnswer: answer,
    orderLegacy: legacyFallback,
  };
}

function parseOrderTokenEntry(entry, index) {
  const parts = entry.split("::");
  if (parts.length > 1) {
    const candidateId = normalizeFieldValue(parts[0]);
    const text = normalizeFieldValue(parts.slice(1).join("::"));
    if (candidateId && text) {
      return { id: candidateId, text };
    }
  }
  return { id: `t${index}`, text: normalizeFieldValue(entry) };
}

function buildOrderCardPayload(card, errors) {
  const front = normalizeFieldValue(card.front || "");
  const tokensList = (card.orderTokens || []).map(normalizeFieldValue).filter(Boolean);
  const labelsListRaw = (card.orderLabels || []).map(normalizeFieldValue).filter(Boolean);
  const answerRaw = normalizeFieldValue(card.orderAnswerRaw || "");
  const line = card.typeLine || 1;

  const missingFields = [];
  if (!front) missingFields.push("FRONT");
  if (!tokensList.length) missingFields.push("TOKENS");
  if (!answerRaw) missingFields.push("ANSWER");
  if (missingFields.length) {
    const label = missingFields.length === 1 ? "Falta" : "Faltan";
    errors.push({ line, message: `${label} ${missingFields.join(", ")}.` });
    return null;
  }
  if (labelsListRaw.length && tokensList.length !== labelsListRaw.length) {
    errors.push({ line, message: "TOKENS y LABELS deben tener la misma longitud." });
    return null;
  }
  const labelsList = labelsListRaw.length
    ? labelsListRaw
    : tokensList.map(() => "");

  const tokens = [];
  const idSet = new Set();
  let hasDuplicateTokenText = false;
  const textCounts = new Map();
  tokensList.forEach((tokenEntry, index) => {
    const parsed = parseOrderTokenEntry(tokenEntry, index);
    if (!parsed.text) return;
    let id = parsed.id || `t${index}`;
    if (idSet.has(id)) {
      errors.push({ line, message: `ID de token duplicado: ${id}` });
      return;
    }
    idSet.add(id);
    const normalizedText = normalizeFieldValue(parsed.text);
    textCounts.set(normalizedText, (textCounts.get(normalizedText) || 0) + 1);
    tokens.push({
      id,
      text: parsed.text,
      label: labelsList[index] || "",
    });
  });

  textCounts.forEach((count) => {
    if (count > 1) hasDuplicateTokenText = true;
  });
  if (!tokens.length || tokens.length !== labelsList.length) {
    errors.push({ line, message: "No se pudieron procesar TOKENS/LABELS." });
    return null;
  }

  let answerIds = [];
  if (/^[\d,\s]+$/.test(answerRaw)) {
    const indices = answerRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => Number(entry));
    if (indices.some((index) => !Number.isInteger(index))) {
      errors.push({ line, message: "ANSWER con índices inválidos." });
      return null;
    }
    if (indices.length !== tokens.length) {
      errors.push({ line, message: "ANSWER debe incluir todos los tokens." });
      return null;
    }
    const uniqueIndices = new Set(indices);
    if (uniqueIndices.size !== indices.length) {
      errors.push({ line, message: "ANSWER contiene índices repetidos." });
      return null;
    }
    if (indices.some((index) => index < 0 || index >= tokens.length)) {
      errors.push({ line, message: "ANSWER contiene índices fuera de rango." });
      return null;
    }
    answerIds = indices.map((index) => tokens[index].id);
  } else {
    const answerTokens = parseDelimitedList(answerRaw);
    if (answerTokens.length !== tokens.length) {
      errors.push({ line, message: "ANSWER debe incluir todos los tokens." });
      return null;
    }
    const tokensByText = tokens.reduce((acc, token) => {
      const key = normalizeFieldValue(token.text);
      if (!acc[key]) acc[key] = [];
      acc[key].push(token.id);
      return acc;
    }, {});
    answerIds = answerTokens.map((tokenEntry) => {
      if (idSet.has(tokenEntry)) return tokenEntry;
      const normalized = normalizeFieldValue(tokenEntry);
      const matches = tokensByText[normalized] || [];
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        errors.push({
          line,
          message: "ANSWER ambiguo: usa índices cuando hay tokens repetidos.",
        });
      } else {
        errors.push({ line, message: `ANSWER contiene token desconocido: ${tokenEntry}` });
      }
      return null;
    });
    if (answerIds.some((id) => !id)) return null;
    if (hasDuplicateTokenText) {
      const usedText = answerTokens.some((tokenEntry) => !idSet.has(tokenEntry));
      if (usedText) {
        errors.push({
          line,
          message: "ANSWER requiere índices o ids cuando hay tokens repetidos.",
        });
        return null;
      }
    }
  }

  return {
    type: "order",
    front,
    orderTokens: tokens,
    orderAnswer: answerIds,
  };
}

function parseInlineCard(line) {
  const parts = line.split(/(?<!\\)::/);
  if (parts.length < 2) return null;
  const front = normalizeFieldValue(unescapeDoubleColon(parts[0].trim()));
  const back = normalizeFieldValue(unescapeDoubleColon(parts.slice(1).join("::").trim()));
  if (!front && !back) return null;
  const legacyOrder = buildLegacyOrderCardPayload(front, back);
  if (legacyOrder) return legacyOrder;
  return { type: "basic", front, back };
}

function parseTagsLine(line) {
  const delimiterIndex = line.indexOf(":");
  if (delimiterIndex === -1) return null;
  const label = line.slice(0, delimiterIndex);
  if (!/\b(tags?|etiquetas)\b/i.test(label)) return null;
  const value = line.slice(delimiterIndex + 1);
  const tags = value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return tags;
}

function parseFolderLine(line) {
  const match = line.match(/^\s*(folder|carpeta)\s*:\s*(.+)$/i);
  if (!match) return null;
  return match[2].trim();
}

function parseTypeLine(line) {
  const match = line.match(/^\s*type\s*:\s*(.+)$/i);
  if (!match) return null;
  return match[1].trim();
}

function parseFieldLine(line) {
  const match = line.match(/^\s*(front|back|text|answer|tokens|labels)\s*:\s*(.*)$/i);
  if (!match) return null;
  return { field: match[1].toLowerCase(), value: match[2] };
}

function isTypeMarker(line) {
  return /^\s*type\s*:/i.test(line);
}

function isTagsMarker(line) {
  return /\b(tags?|etiquetas)\b/i.test(line) && line.includes(":");
}

function isGlossaryMarker(line) {
  return /^\s*glossary\s*:/i.test(line);
}

function isImplicitFolderLine(line, nextLine, nextNextLine) {
  if (!line || line.includes(":") || !line.includes("/")) return false;
  if (isTagsMarker(nextLine) || isTypeMarker(nextLine)) return true;
  if (!nextLine && isTypeMarker(nextNextLine)) return true;
  return false;
}

export function parseChankiImport(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { blocks: [], errors: [], glossary: [] };
  }

  const lines = text.split(/\r?\n/);
  const blocks = [];
  const errors = [];
  const glossary = [];
  let currentBlock = null;
  let currentCard = null;
  let currentField = null;
  let lastFolderPath = null;
  let lastTags = [];
  let pendingTags = null;
  let inGlossary = false;
  let skipInvalidType = false;

  const ensureBlock = (folderPath = null, lineStart = null) => {
    if (currentBlock) return;
    const resolvedFolder = folderPath ?? lastFolderPath ?? null;
    const resolvedTags = pendingTags ?? lastTags ?? [];
    currentBlock = {
      folderPath: resolvedFolder,
      tags: [...resolvedTags],
      cards: [],
      startLine: lineStart || 1,
    };
    pendingTags = null;
  };

  const finalizeBlock = () => {
    if (!currentBlock) return;
    if (currentBlock.cards.length) {
      blocks.push(currentBlock);
    }
    currentBlock = null;
  };

  const flushCard = () => {
    if (!currentCard) return;
    if (currentCard.type === "cloze") {
      const hasContent = Boolean(currentCard.clozeText || currentCard.clozeAnswers?.length);
      if (hasContent) {
        currentBlock.cards.push({
          type: "cloze",
          clozeText: normalizeFieldValue(currentCard.clozeText || ""),
          clozeAnswers: (currentCard.clozeAnswers || []).map(normalizeFieldValue).filter(Boolean),
        });
      }
    } else if (currentCard.type === "order") {
      const payload = buildOrderCardPayload(currentCard, errors);
      if (payload) {
        currentBlock.cards.push(payload);
      }
    } else {
      const hasContent = Boolean(currentCard.front || currentCard.back);
      if (hasContent) {
        const normalizedFront = normalizeFieldValue(currentCard.front || "");
        const normalizedBack = normalizeFieldValue(currentCard.back || "");
        const legacyOrder = buildLegacyOrderCardPayload(normalizedFront, normalizedBack);
        currentBlock.cards.push(
          legacyOrder || {
            type: "basic",
            front: normalizedFront,
            back: normalizedBack,
          }
        );
      }
    }
    currentCard = null;
    currentField = null;
  };

  const startNewBlock = (folderPath, lineStart) => {
    flushCard();
    finalizeBlock();
    ensureBlock(folderPath, lineStart);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    const lineNumber = index + 1;
    const nextLine = (lines[index + 1] || "").trim();
    const nextNextLine = (lines[index + 2] || "").trim();

    if (!line) {
      currentField = null;
      continue;
    }

    if (isGlossaryMarker(line)) {
      flushCard();
      finalizeBlock();
      inGlossary = true;
      continue;
    }

    if (inGlossary) {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const word = parts[0].trim();
        const meaning = parts.slice(1).join("=").trim();
        if (word && meaning) {
          glossary.push({ word, meaning });
        }
      }
      continue;
    }

    const folderPath = parseFolderLine(line);
    if (folderPath) {
      lastFolderPath = folderPath;
      startNewBlock(folderPath, lineNumber);
      skipInvalidType = false;
      continue;
    }

    if (isImplicitFolderLine(line, nextLine, nextNextLine)) {
      lastFolderPath = line.trim();
      startNewBlock(lastFolderPath, lineNumber);
      skipInvalidType = false;
      continue;
    }

    const tags = parseTagsLine(line);
    if (tags) {
      lastTags = tags;
      if (currentBlock && currentBlock.cards.length) {
        const carryFolder = currentBlock.folderPath || lastFolderPath || null;
        finalizeBlock();
        ensureBlock(carryFolder, lineNumber);
      } else if (!currentBlock) {
        pendingTags = tags;
      }
      if (currentBlock) {
        currentBlock.tags = [...tags];
      }
      continue;
    }

    if (line === "---") {
      flushCard();
      skipInvalidType = false;
      continue;
    }

    const typeValue = parseTypeLine(line);
    if (typeValue !== null) {
      const normalized = typeValue.trim().toLowerCase();
      if (normalized !== "basic" && normalized !== "cloze" && normalized !== "order") {
        errors.push({ line: lineNumber, message: `TYPE inválido: ${typeValue}` });
        skipInvalidType = true;
        currentCard = null;
        currentField = null;
        continue;
      }
      skipInvalidType = false;
      ensureBlock(null, lineNumber);
      if (currentCard) {
        flushCard();
      }
      currentCard = { type: normalized, typeLine: lineNumber };
      currentField = null;
      continue;
    }

    if (skipInvalidType) {
      continue;
    }

    const inlineCard = parseInlineCard(line);
    if (inlineCard) {
      ensureBlock(null, lineNumber);
      if (currentCard) {
        flushCard();
      }
      currentBlock.cards.push(inlineCard);
      currentField = null;
      continue;
    }

    const fieldLine = parseFieldLine(line);
    if (fieldLine) {
      ensureBlock(null, lineNumber);
      if (!currentCard) {
        currentCard = {
          type: fieldLine.field === "text" || fieldLine.field === "answer"
            ? "cloze"
            : fieldLine.field === "tokens" || fieldLine.field === "labels"
              ? "order"
              : "basic",
          typeLine: lineNumber,
        };
      }
      if (fieldLine.field === "front") {
        currentCard.front = normalizeFieldValue(fieldLine.value);
        if (currentCard.type !== "order") {
          currentCard.type = "basic";
        }
      } else if (fieldLine.field === "back") {
        currentCard.back = normalizeFieldValue(fieldLine.value);
        if (currentCard.type !== "order") {
          currentCard.type = "basic";
        }
      } else if (fieldLine.field === "text") {
        currentCard.clozeText = normalizeFieldValue(fieldLine.value);
        currentCard.type = "cloze";
      } else if (fieldLine.field === "answer") {
        if (currentCard.type === "order") {
          currentCard.orderAnswerRaw = normalizeFieldValue(fieldLine.value);
        } else {
          currentCard.clozeAnswers = fieldLine.value
            .split("|")
            .map((answer) => normalizeFieldValue(answer))
            .filter(Boolean);
          currentCard.type = "cloze";
        }
      } else if (fieldLine.field === "tokens") {
        currentCard.orderTokens = parseDelimitedList(fieldLine.value);
        currentCard.type = "order";
      } else if (fieldLine.field === "labels") {
        currentCard.orderLabels = parseDelimitedList(fieldLine.value);
        currentCard.type = "order";
      }
      currentField = fieldLine.field;
      continue;
    }

    if (currentCard && currentField) {
      const appendValue = normalizeFieldValue(line);
      if (currentField === "front") {
        currentCard.front = normalizeFieldValue(`${currentCard.front || ""} ${appendValue}`);
      } else if (currentField === "back") {
        currentCard.back = normalizeFieldValue(`${currentCard.back || ""} ${appendValue}`);
      } else if (currentField === "text") {
        currentCard.clozeText = normalizeFieldValue(`${currentCard.clozeText || ""} ${appendValue}`);
      } else if (currentField === "answer") {
        if (currentCard.type === "order") {
          currentCard.orderAnswerRaw = normalizeFieldValue(
            `${currentCard.orderAnswerRaw || ""} ${appendValue}`
          );
        } else {
          if (!currentCard.clozeAnswers) currentCard.clozeAnswers = [];
          const lastAnswer = currentCard.clozeAnswers.pop() || "";
          currentCard.clozeAnswers.push(normalizeFieldValue(`${lastAnswer} ${appendValue}`));
        }
      } else if (currentField === "tokens") {
        if (!currentCard.orderTokens) currentCard.orderTokens = [];
        const lastToken = currentCard.orderTokens.pop() || "";
        currentCard.orderTokens.push(normalizeFieldValue(`${lastToken} ${appendValue}`));
      } else if (currentField === "labels") {
        if (!currentCard.orderLabels) currentCard.orderLabels = [];
        const lastLabel = currentCard.orderLabels.pop() || "";
        currentCard.orderLabels.push(normalizeFieldValue(`${lastLabel} ${appendValue}`));
      }
    }
  }

  flushCard();
  finalizeBlock();

  return { blocks, errors, glossary };
}

export function parseImport(text) {
  const parsed = parseChankiImport(text);
  if (!parsed.blocks.length) {
    return { cards: [], folderPath: null, tags: [], glossary: parsed.glossary };
  }
  const cards = parsed.blocks.flatMap((block) =>
    block.cards.map((card) => ({ ...card, tags: block.tags || [] }))
  );
  return {
    cards,
    folderPath: parsed.blocks[0]?.folderPath || null,
    tags: parsed.blocks[0]?.tags || [],
    glossary: parsed.glossary,
  };
}
