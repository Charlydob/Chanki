const PRONOUN_TOKENS = ["ich", "du", "er/sie/es", "wir", "ihr", "sie / Sie"];
const HEADING_REGEX = /^(INDIKATIV|KONJUNKTIV|IMPERATIV)\b[A-ZÄÖÜẞ0-9\s/-]*$/;
const PRONOUN_PREFIX_REGEX = /^(ICH|DU|ER\s*\/\s*SIE\s*\/\s*ES|ER\/SIE\/ES|WIR|IHR|SIE|SIE\s)/;
const HEADING_KEYS = [
  "INDIKATIV PRÄSENS", "INDIKATIV PRÄTERITUM", "INDIKATIV FUTUR I", "INDIKATIV PERFEKT", "INDIKATIV PLUSQUAMPERFEKT", "INDIKATIV FUTUR II",
  "KONJUNKTIV I PRÄSENS", "KONJUNKTIV I FUTUR I", "KONJUNKTIV I PERFEKT", "KONJUNKTIV I FUTUR II",
  "KONJUNKTIV II PRÄTERITUM", "KONJUNKTIV II FUTUR I", "KONJUNKTIV II PLUSQUAMPERFEKT", "KONJUNKTIV II FUTUR II",
  "IMPERATIV PRÄSENS",
];

function normalizeHeading(line = "") {
  return String(line || "").replace(/\s+/g, " ").trim().toUpperCase();
}
function canonicalHeading(line = "") {
  const normalized = normalizeHeading(line).replace(/\b([IVX]+)\b/g, (m) => {
    if (m === "1") return "I";
    if (m === "2") return "II";
    return m;
  });
  return HEADING_KEYS.find((h) => normalized.includes(h)) || normalized;
}

function normalizePronounToken(token = "") {
  return String(token || "")
    .replace(/\s+/g, "")
    .replace(/er\/?sie\/?es/gi, "er/sie/es")
    .replace(/sie\/?sie/gi, "sie")
    .replace(/^sie$/i, "sie");
}

function extractInfinitiveFromBlocks(blocks = []) {
  for (const block of blocks) {
    const wir = block?.forms?.get?.("wir");
    if (wir) return wir.split(/\s+/)[0].trim();
    const ich = block?.forms?.get?.("ich");
    if (ich) return /e$/i.test(ich) ? `${ich.slice(0, -1)}en` : ich;
  }
  return "verbo";
}

function parseBlockLines(lines = []) {
  const forms = new Map();
  lines.forEach((line) => {
    const clean = String(line || "").trim();
    if (!clean) return;
    const match = clean.match(/^(ich|du|er\s*\/\s*sie\s*\/\s*es|er\/?sie\/?es|wir|ihr|sie\s*\/\s*sie|sie|Sie)\s+(.+)$/i);
    if (!match) return;
    const key = normalizePronounToken(match[1]);
    const value = match[2].replace(/^[-–—]\s*/, "").trim();
    if (!value) return;
    forms.set(key, value);
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
    const heading = canonicalHeading(line);
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
      .replace(/(ich|du|er\/sie\/es|wir|ihr|sie\s*\/\s*Sie|sie|Sie)/g, "\n$1")
      .split(/\n+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    current.lines.push(...expanded);
  });

  const normalizedBlocks = blocks
    .map((block) => ({ heading: block.heading, forms: parseBlockLines(block.lines), raw: block.lines.join("\n").trim() }))
    .filter((block) => block.forms.size || block.raw);

  if (!normalizedBlocks.length) return null;
  const infinitive = extractInfinitiveFromBlocks(normalizedBlocks);
  const output = [`[${infinitive}]`];

  const showHeadings = normalizedBlocks.length > 1 || !/^INDIKATIV PRÄSENS$/i.test(normalizedBlocks[0]?.heading || "");
  normalizedBlocks.forEach((block) => {
    if (showHeadings) output.push(block.heading);
    PRONOUN_TOKENS.forEach((pronoun) => {
      const label = pronoun === "er/sie/es" ? "er / sie / es" : pronoun === "sie" ? "sie / Sie" : pronoun;
      const formKey = pronoun === "sie / Sie" ? "sie" : pronoun;
      output.push(`${label} - ${block.forms.get(formKey) || "-"}`);
    });
    output.push("");
  });

  const blocksOut = normalizedBlocks.map((block) => ({
    id: block.heading.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-+|-+$/g, ""),
    heading: block.heading,
    label: block.heading,
    lines: PRONOUN_TOKENS.map((pronoun) => {
      const formKey = pronoun === "sie / Sie" ? "sie" : pronoun;
      const label = pronoun === "er/sie/es" ? "er / sie / es" : pronoun;
      return { pronoun: label, value: block.forms.get(formKey) || "-" };
    }),
    raw: block.raw,
  }));
  return {
    infinitive,
    conjugations: Object.fromEntries(blocksOut.map((block) => [
      block.heading,
      block.lines.map((line) => `${line.pronoun} - ${line.value}`).join("\n"),
    ])),
    blocks: blocksOut,
    formatted: output.join("\n").trim(),
  };
}
