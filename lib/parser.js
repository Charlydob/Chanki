function unescapeDoubleColon(text) {
  return text.replace(/\\::/g, "::");
}

function normalizeFieldValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseInlineCard(line) {
  const parts = line.split(/(?<!\\)::/);
  if (parts.length < 2) return null;
  const front = normalizeFieldValue(unescapeDoubleColon(parts[0].trim()));
  const back = normalizeFieldValue(unescapeDoubleColon(parts.slice(1).join("::").trim()));
  if (!front && !back) return null;
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
  const match = line.match(/^\s*(front|back|text|answer)\s*:\s*(.*)$/i);
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
    } else {
      const hasContent = Boolean(currentCard.front || currentCard.back);
      if (hasContent) {
        currentBlock.cards.push({
          type: "basic",
          front: normalizeFieldValue(currentCard.front || ""),
          back: normalizeFieldValue(currentCard.back || ""),
        });
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
      if (normalized !== "basic" && normalized !== "cloze") {
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
      currentCard = { type: normalized };
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
          type: fieldLine.field === "text" || fieldLine.field === "answer" ? "cloze" : "basic",
        };
      }
      if (fieldLine.field === "front") {
        currentCard.front = normalizeFieldValue(fieldLine.value);
        currentCard.type = "basic";
      } else if (fieldLine.field === "back") {
        currentCard.back = normalizeFieldValue(fieldLine.value);
        currentCard.type = "basic";
      } else if (fieldLine.field === "text") {
        currentCard.clozeText = normalizeFieldValue(fieldLine.value);
        currentCard.type = "cloze";
      } else if (fieldLine.field === "answer") {
        currentCard.clozeAnswers = fieldLine.value
          .split("|")
          .map((answer) => normalizeFieldValue(answer))
          .filter(Boolean);
        currentCard.type = "cloze";
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
        if (!currentCard.clozeAnswers) currentCard.clozeAnswers = [];
        const lastAnswer = currentCard.clozeAnswers.pop() || "";
        currentCard.clozeAnswers.push(normalizeFieldValue(`${lastAnswer} ${appendValue}`));
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
