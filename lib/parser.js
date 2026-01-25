function unescapeDoubleColon(text) {
  return text.replace(/\\::/g, "::");
}

export function parseImport(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { cards: [], folderPath: null, tags: [] };
  }

  if (/^FOLDER:/im.test(trimmed)) {
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
      return { front, back, tags: [] };
    })
    .filter(Boolean);
  return { cards, folderPath: null, tags: [] };
}

function parseFormatB(text) {
  const lines = text.split(/\r?\n/);
  let folderPath = null;
  let tags = [];
  const blocks = [];
  let current = {};

  const flush = () => {
    if (current.front || current.back) {
      blocks.push({
        front: current.front || "",
        back: current.back || "",
      });
    }
    current = {};
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
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
    if (line.startsWith("FRONT:")) {
      current.front = line.replace("FRONT:", "").trim();
      continue;
    }
    if (line.startsWith("BACK:")) {
      current.back = line.replace("BACK:", "").trim();
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

  return { cards, folderPath, tags };
}
