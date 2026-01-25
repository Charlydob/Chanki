function unescapeDoubleColon(text) {
  return text.replace(/\\::/g, "::");
}

export function parseImport(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { cards: [], folderPath: null, tags: [], glossary: [] };
  }

  if (/^(FOLDER|TAGS|TYPE|FRONT|BACK|TEXT|ANSWER|GLOSSARY):/im.test(trimmed)) {
    return parseFormatB(trimmed);
  }
  return parseFormatA(trimmed);
}

function parseFormatA(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const cards = lines
    .map((line) => {
      const parts = line.split(/(?<!\\)::/);
      if (parts.length < 2) {
        return null;
      }
      const front = unescapeDoubleColon(parts[0].trim());
      const back = unescapeDoubleColon(parts.slice(1).join("::").trim());
      return { type: "basic", front, back, tags: [] };
    })
    .filter(Boolean);
  return { cards, folderPath: null, tags: [], glossary: [] };
}

function parseFormatB(text) {
  const lines = text.split(/\r?\n/);
  let folderPath = null;
  let tags = [];
  const glossary = [];
  const blocks = [];
  let current = {};
  let currentType = "basic";
  let inGlossary = false;

  const isCurrentComplete = () => {
    if (current.type === "cloze") {
      return Boolean(current.clozeText && current.clozeAnswers?.length);
    }
    return Boolean(current.front && current.back);
  };

  const hasCurrentData = () => {
    return Boolean(
      current.front ||
        current.back ||
        current.clozeText ||
        current.clozeAnswers?.length
    );
  };

  const flush = () => {
    if (current.type === "cloze" && (current.clozeText || current.clozeAnswers?.length)) {
      blocks.push({
        type: "cloze",
        clozeText: current.clozeText || "",
        clozeAnswers: current.clozeAnswers || [],
      });
      current = {};
      currentType = "basic";
      return;
    }
    if (current.front || current.back) {
      blocks.push({
        type: "basic",
        front: current.front || "",
        back: current.back || "",
      });
    }
    current = {};
    currentType = "basic";
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("GLOSSARY:")) {
      if (hasCurrentData()) {
        flush();
      }
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
    if (line.startsWith("FOLDER:")) {
      folderPath = line.replace("FOLDER:", "").trim();
      continue;
    }
    if (line.startsWith("TAGS:")) {
      tags = line
        .replace("TAGS:", "")
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (line === "---") {
      flush();
      continue;
    }
    if (line.startsWith("TYPE:")) {
      if (isCurrentComplete()) {
        flush();
      } else if (hasCurrentData()) {
        current = {};
      }
      currentType = line.replace("TYPE:", "").trim().toLowerCase();
      current.type = currentType;
      continue;
    }
    const inlineParts = line.split(/(?<!\\)::/);
    if (inlineParts.length >= 2) {
      if (isCurrentComplete()) {
        flush();
      } else if (hasCurrentData()) {
        current = {};
      }
      const front = unescapeDoubleColon(inlineParts[0].trim());
      const back = unescapeDoubleColon(inlineParts.slice(1).join("::").trim());
      if (front && back) {
        blocks.push({
          type: "basic",
          front,
          back,
        });
      }
      continue;
    }
    if (line.startsWith("FRONT:")) {
      current.front = line.replace("FRONT:", "").trim();
      continue;
    }
    if (line.startsWith("BACK:")) {
      current.back = line.replace("BACK:", "").trim();
      continue;
    }
    if (line.startsWith("TEXT:")) {
      current.clozeText = line.replace("TEXT:", "").trim();
      current.type = "cloze";
      continue;
    }
    if (line.startsWith("ANSWER:")) {
      const answerText = line.replace("ANSWER:", "").trim();
      current.clozeAnswers = answerText
        .split(" | ")
        .map((answer) => answer.trim())
        .filter(Boolean);
      current.type = "cloze";
      continue;
    }
    if (current.front && !current.back) {
      current.back = `${current.back || ""}${current.back ? "\n" : ""}${line}`;
    }
  }
  flush();

  const cards = blocks.map((card) => ({
    ...card,
    tags,
  }));

  return { cards, folderPath, tags, glossary };
}
