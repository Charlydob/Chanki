function normalizePronounToken(token = "") {
  return String(token || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/er\/?sie\/?es/g, "er/sie/es")
    .replace(/^sie$/, "sie");
}

function extractInfinitiveFromForms(forms = {}) {
  const wir = String(forms.wir || "").trim();
  if (wir) return wir;
  const formalSie = String(forms.Sie || "").trim();
  if (formalSie) return formalSie;
  const ich = String(forms.ich || "").trim();
  if (!ich) return "verbo";
  if (/e$/i.test(ich)) return `${ich.slice(0, -1)}en`;
  return ich;
}

export function parseGermanConjugationPaste(raw = "") {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const withDelimiters = text
    .replace(/er\s*\/\s*sie\s*\/\s*es/gi, "\ner/sie/es")
    .replace(/(ich|du|wir|ihr|Sie)\b/g, "\n$1")
    .trim();

  const pronounOrder = ["ich", "du", "er/sie/es", "wir", "ihr", "Sie"];
  const pronounMap = new Map(pronounOrder.map((key) => [key, key]));
  const forms = {};

  withDelimiters
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^(ich|du|er\/?sie\/?es|wir|ihr|Sie|sie)\s+(.+)$/i);
      if (!match) return;
      const rawPronoun = match[1];
      const value = match[2].trim().replace(/^[-–—]\s*/, "");
      if (!value) return;
      const normalizedPronoun = normalizePronounToken(rawPronoun);
      const key = pronounMap.get(normalizedPronoun) || (normalizedPronoun === "sie" ? "Sie" : null);
      if (!key) return;
      forms[key] = value;
    });

  if (!Object.keys(forms).length) return null;

  if (!forms.Sie && forms.sie) forms.Sie = forms.sie;
  const infinitive = extractInfinitiveFromForms(forms);
  return `[${infinitive}]
ich - ${forms.ich || "-"}
du - ${forms.du || "-"}
er / sie / es - ${forms["er/sie/es"] || "-"}
wir - ${forms.wir || "-"}
ihr - ${forms.ihr || "-"}
sie / Sie - ${forms.Sie || "-"}`;
}

