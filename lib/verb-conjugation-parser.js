const PRONOUN_TOKENS = ["ich", "du", "er/sie/es", "wir", "ihr", "sie"];
const HEADING_REGEX = /^(INDIKATIV|KONJUNKTIV|IMPERATIV)\b[A-ZÄÖÜẞ0-9\s/-]*$/;
const PRONOUN_PREFIX_REGEX = /^(ICH|DU|ER\s*\/\s*SIE\s*\/\s*ES|ER\/SIE\/ES|WIR|IHR|SIE|SIE\s)/;

function normalizeHeading(line = "") {
  return String(line || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function normalizePronounToken(token = "") {
  return String(token || "")
    .replace(/\s+/g, "")
    .replace(/er\/?sie\/?es/gi, "er/sie/es")
    .replace(/^sie$/i, "sie");
}

function extractInfinitiveFromBlocks(blocks = []) {
  for (const block of blocks) {
    const wir = block?.forms?.wir;
    if (wir) return wir.split(/\s+/)[0].trim();
    const ich = block?.forms?.ich;
    if (ich) return /e$/i.test(ich) ? `${ich.slice(0, -1)}en` : ich;
  }
  return "verbo";
}

function parseBlockLines(lines = []) {
  const forms = {};
  lines.forEach((line) => {
    const clean = String(line || "").trim();
    if (!clean) return;
    const match = clean.match(/^(ich|du|er\s*\/\s*sie\s*\/\s*es|er\/?sie\/?es|wir|ihr|sie|Sie)\s+(.+)$/i);
    if (!match) return;
    const key = normalizePronounToken(match[1]);
    const value = match[2].replace(/^[-–—]\s*/, "").trim();
    if (!value) return;
    forms[key] = value;
  });
  return forms;
}

export function parseGermanConjugationPaste(raw = "") {
  const source = String(raw || "").replace(/\r/g, "").trim();
  if (!source) return null;
  const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const blocks = [];
  let current = null;

  lines.forEach((line) => {
    const heading = normalizeHeading(line);
    if (HEADING_REGEX.test(heading) && !PRONOUN_PREFIX_REGEX.test(heading)) {
      current = { heading, lines: [] };
      blocks.push(current);
      return;
    }
    if (heading === "AD") return;
    if (!current) {
      current = { heading: "INDIKATIV PRÄSENS", lines: [] };
      blocks.push(current);
    }
    const expanded = line
      .replace(/er\s*\/\s*sie\s*\/\s*es/gi, "er/sie/es")
      .replace(/(ich|du|er\/sie\/es|wir|ihr|sie|Sie)/g, "\n$1")
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    current.lines.push(...expanded);
  });

  const normalizedBlocks = blocks
    .map((block) => ({ heading: block.heading, forms: parseBlockLines(block.lines), raw: block.lines.join("\n").trim() }))
    .filter((block) => Object.keys(block.forms).length || block.raw);

  if (!normalizedBlocks.length) return null;
  const infinitive = extractInfinitiveFromBlocks(normalizedBlocks);
  const output = [`[${infinitive}]`];

  const showHeadings = normalizedBlocks.length > 1 || !/^INDIKATIV PRÄSENS$/i.test(normalizedBlocks[0]?.heading || "");
  normalizedBlocks.forEach((block) => {
    if (showHeadings) output.push(block.heading);
    PRONOUN_TOKENS.forEach((pronoun) => {
      const label = pronoun === "er/sie/es" ? "er / sie / es" : pronoun === "sie" ? "sie / Sie" : pronoun;
      const formKey = pronoun === "Sie" ? "sie" : pronoun;
      output.push(`${label} - ${block.forms[formKey] || "-"}`);
    });
    output.push("");
  });

  return {
    infinitive,
    conjugations: Object.fromEntries(
      normalizedBlocks.map((block) => [
        block.heading,
        (Object.keys(block.forms || {}).length ? PRONOUN_TOKENS.map((pronoun) => {
          const label = pronoun === "er/sie/es" ? "er / sie / es" : pronoun === "sie" ? "sie / Sie" : pronoun;
          return `${label} - ${block.forms[pronoun] || "-"}`;
        }).join("\n") : (block.raw || "")),
      ])
    ),
    blocks: normalizedBlocks.map((block) => ({
      heading: block.heading,
      label: block.heading.replace(/^(?:INDIKATIV|KONJUNKTIV\s+[IⅡ1]+|IMPERATIV)\s*/i, "").trim() || block.heading,
      forms: block.forms,
      raw: block.raw,
    })),
    formatted: output.join("\n").trim(),
  };
}
