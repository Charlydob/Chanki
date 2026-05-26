const PRONOUN_TOKENS = ["ich", "du", "er / sie / es", "wir", "ihr", "sie / Sie"];
const HEADING_REGEX = /^(INDIKATIV|KONJUNKTIV|IMPERATIV)\b[A-ZÄÖÜẞ0-9\s/-]*$/;
const HEADING_KEYS = [
  "INDIKATIV PRÄSENS", "INDIKATIV PRÄTERITUM", "INDIKATIV FUTUR I", "INDIKATIV PERFEKT", "INDIKATIV PLUSQUAMPERFEKT", "INDIKATIV FUTUR II",
  "KONJUNKTIV I PRÄSENS", "KONJUNKTIV I FUTUR I", "KONJUNKTIV I PERFEKT", "KONJUNKTIV I FUTUR II",
  "KONJUNKTIV II PRÄTERITUM", "KONJUNKTIV II FUTUR I", "KONJUNKTIV II PLUSQUAMPERFEKT", "KONJUNKTIV II FUTUR II",
  "IMPERATIV PRÄSENS",
];

function normalizeHeading(line = "") { return String(line || "").replace(/\s+/g, " ").trim().toUpperCase(); }
function canonicalHeading(line = "") {
  const normalized = normalizeHeading(line).replace(/\b1\b/g, "I").replace(/\b2\b/g, "II");
  return HEADING_KEYS.find((h) => normalized.includes(h)) || normalized;
}
const slugify = (s = "") => normalizeHeading(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "conjugation";

function splitConjugationLine(line = "") {
  return String(line || "")
    .replace(/er\s*\/\s*sie\s*\/\s*es/gi, "er / sie / es")
    .replace(/(ich|du|er\s*\/\s*sie\s*\/\s*es|wir|ihr|sie\s*\/\s*Sie|Sie|sie)\s+/g, "\n$1 ")
    .split(/\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}


function parseImperativeFallback(lines = "") {
  const compact = String(lines || "").replace(/\s+/g, " ");
  const du = compact.match(/([a-zäöüß]+)\s*\(du\)/i);
  const wir = compact.match(/([a-zäöüß]+\s+wir)/i);
  const ihr = compact.match(/([a-zäöüß]+\s+ihr)/i);
  const sie = compact.match(/([a-zäöüß]+\s+Sie)/i);
  return { du: du?.[1] || "-", wir: wir?.[1] || "-", ihr: ihr?.[1] || "-", sie: sie?.[1] || "-" };
}

function normalizeLines(lines = [], heading = "") {
  const forms = new Map();
  for (const line of lines.flatMap(splitConjugationLine)) {
    if (normalizeHeading(line) === "AD") continue;
    const m = line.match(/^(ich|du|er\s*\/\s*sie\s*\/\s*es|wir|ihr|sie\s*\/\s*Sie|Sie|sie)\s*[-–—]?\s*(.+)$/i);
    if (!m) continue;
    const p = m[1].replace(/\s+/g, " ").trim().toLowerCase();
    const v = m[2].trim();
    if (!v) continue;
    if (p === "sie" || p === "sie / sie") forms.set("sie / Sie", v);
    else if (p.includes("er")) forms.set("er / sie / es", v);
    else forms.set(p, v);
  }
  let out = PRONOUN_TOKENS.map((pronoun) => ({ pronoun, value: forms.get(pronoun) || "-" }));
  if (!forms.size && /^IMPERATIV/.test(normalizeHeading(heading))) {
    const imp = parseImperativeFallback(lines.join(" "));
    out = [
      { pronoun: "ich", value: "-" },
      { pronoun: "du", value: imp.du },
      { pronoun: "er / sie / es", value: "-" },
      { pronoun: "wir", value: imp.wir },
      { pronoun: "ihr", value: imp.ihr },
      { pronoun: "sie / Sie", value: imp.sie },
    ];
  }
  return out;
}

export function parseConjugationBlocks(rawText = "") {
  const source = String(rawText || "").replace(/\r/g, "").trim();
  if (!source) return [];
  const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = canonicalHeading(line);
    if (HEADING_REGEX.test(heading)) {
      current = { heading, label: heading, lines: [] };
      blocks.push(current);
      continue;
    }
    if (normalizeHeading(line) === "AD") continue;
    if (!current) {
      current = { heading: "INDIKATIV PRÄSENS", label: "INDIKATIV PRÄSENS", lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks.map((block) => {
    const parsedLines = normalizeLines(block.lines, block.heading);
    const raw = parsedLines.map((l) => `${l.pronoun} - ${l.value}`).join("\n");
    return { id: slugify(block.heading), heading: block.heading, label: block.label, raw, lines: parsedLines };
  }).filter((b) => b.lines.some((l) => l.value && l.value !== "-"));
}

export function parseGermanConjugationPaste(raw = "") {
  const blocks = parseConjugationBlocks(raw);
  if (!blocks.length) return null;
  return { blocks, conjugations: blocks };
}
