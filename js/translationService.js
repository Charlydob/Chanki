function safeTrim(value) {
  return String(value ?? "").trim();
}

function normalizeVariantList(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = safeTrim(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function normalizeSenseKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[.,;:!?¡¿'"“”‘’()\[\]{}]/g, " ")
    .replace(/\b(el|la|los|las|un|una|unos|unas|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearDuplicateSense(a, b) {
  const aa = normalizeSenseKey(a);
  const bb = normalizeSenseKey(b);
  if (!aa || !bb) return false;
  if (aa === bb) return true;
  return aa.includes(bb) || bb.includes(aa);
}

function dedupeSenseObjects(items = []) {
  const out = [];
  for (const item of items) {
    const translation = safeTrim(item?.translation);
    if (!translation) continue;
    const nuance = safeTrim(item?.nuance);
    const next = { translation, nuance, source: item?.source || "unknown" };
    const existing = out.find((entry) => isNearDuplicateSense(entry.translation, translation));
    if (!existing) {
      out.push(next);
      continue;
    }
    if (!existing.nuance && nuance) existing.nuance = nuance;
  }
  return out;
}

function isInstitutionalNoise(text = "") {
  const sample = String(text || "").toLowerCase();
  return /(reglamento|ministerio|art(ículo)?\.?|secci[oó]n|bolet[ií]n|resoluci[oó]n|parlamento|gmbh|inc\.?|ltd\.?|copyright)/i.test(sample);
}

function isCleanWordSense(text = "", { strictWord = true } = {}) {
  const clean = safeTrim(text);
  if (!clean) return false;
  if (/\b\d{2,}\b/.test(clean)) return false;
  if (isInstitutionalNoise(clean)) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (strictWord && words.length > 10) return false;
  if (strictWord && words.length > 4 && /[.,;:!?]/.test(clean)) return false;
  return true;
}

async function fetchWithLogs(endpoint, options, { sourceLang, targetLang, text, mode, signal }) {
  const payload = { sourceLang, targetLang, text, mode, endpoint };
  console.info("[translate:request]", payload);
  try {
    const res = await fetch(endpoint, { ...options, signal });
    const raw = await res.text();
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    console.info("[translate:response]", { status: res.status, body });
    if (!res.ok) throw new Error(`http-${res.status}`);
    return body;
  } catch (error) {
    console.error("[translate:error]", error);
    throw error;
  }
}

async function translateWithDeepL(ctx, deeplKey) {
  const params = new URLSearchParams({
    text: ctx.text,
    source_lang: ctx.sourceLang.toUpperCase(),
    target_lang: ctx.targetLang.toUpperCase(),
  });
  const body = await fetchWithLogs("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${deeplKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  }, ctx);
  return safeTrim(body?.translations?.[0]?.text);
}

async function translateWithLibre(ctx, libreBase) {
  const body = await fetchWithLogs(`${libreBase}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: ctx.text, source: ctx.sourceLang, target: ctx.targetLang, format: "text" }),
  }, ctx);
  return safeTrim(body?.translatedText);
}

async function translateWithMyMemory(ctx) {
  const endpoint = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(ctx.text)}&langpair=${ctx.sourceLang}|${ctx.targetLang}`;
  const body = await fetchWithLogs(endpoint, { method: "GET" }, ctx);
  return {
    main: safeTrim(body?.responseData?.translatedText),
    matches: normalizeVariantList((body?.matches || []).map((m) => m?.translation)),
  };
}

async function fetchWiktionarySenses(ctx) {
  const endpoint = `https://${ctx.sourceLang}.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(ctx.text)}&prop=wikitext&format=json&origin=*`;
  const body = await fetchWithLogs(endpoint, { method: "GET" }, ctx);
  const wiki = String(body?.parse?.wikitext?.["*"] || "");
  if (!wiki) return [];
  const regex = new RegExp(`\\{\\{t\\+?\\|${ctx.targetLang}\\|([^|}]+)`, "gi");
  const senses = [];
  let match;
  while ((match = regex.exec(wiki)) !== null) {
    senses.push({ translation: safeTrim(match[1]), nuance: "Wiktionary", source: "wiktionary" });
  }
  return dedupeSenseObjects(senses).slice(0, 8);
}

function scoreSenseWithContext(sense, contextText = "") {
  const ctx = normalizeSenseKey(contextText);
  if (!ctx) return 0;
  const trans = normalizeSenseKey(sense.translation);
  const nuance = normalizeSenseKey(sense.nuance);
  let score = 0;
  if (trans && ctx.includes(trans)) score += 6;
  if (nuance && ctx.includes(nuance)) score += 3;
  return score;
}

function formatWordSenses(senses = []) {
  if (!senses.length) return "";
  if (senses.length === 1) return senses[0].translation;
  return senses.map((item, idx) => `${idx + 1}. ${item.translation}${item.nuance ? ` — ${item.nuance}` : ""}`).join("\n");
}

async function translateWordWithEnrichment(ctx, { deeplKey, libreBase }) {
  const [wikiSenses, myMemory] = await Promise.allSettled([
    fetchWiktionarySenses(ctx),
    translateWithMyMemory(ctx),
  ]);
  const senses = [];
  if (wikiSenses.status === "fulfilled") senses.push(...wikiSenses.value);
  if (myMemory.status === "fulfilled") {
    senses.push(...myMemory.value.matches.map((translation) => ({ translation, nuance: "uso frecuente", source: "mymemory" })));
    if (myMemory.value.main) senses.unshift({ translation: myMemory.value.main, nuance: "principal", source: "mymemory" });
  }

  if (!senses.length) {
    const fallback = deeplKey
      ? await translateWithDeepL(ctx, deeplKey)
      : await translateWithLibre(ctx, libreBase);
    if (!fallback) return "";
    return fallback;
  }

  const ranked = dedupeSenseObjects(senses)
    .filter((item) => isCleanWordSense(item.translation, { strictWord: true }))
    .map((item) => ({ ...item, contextScore: scoreSenseWithContext(item, ctx.contextText) }))
    .sort((a, b) => b.contextScore - a.contextScore)
    .slice(0, 3);
  return formatWordSenses(ranked);
}

export async function translateTextWithFallback({ text, sourceLang, targetLang, mode = "phrase", signal, contextText = "" }) {
  const cleanText = safeTrim(text);
  if (!cleanText) return "";

  const deeplKey = safeTrim(window.__CHANKI_DEEPL_KEY__ || localStorage.getItem("chanki_deepl_key"));
  const libreBase = safeTrim(window.__CHANKI_LIBRETRANSLATE_URL__ || localStorage.getItem("chanki_libretranslate_url") || "https://libretranslate.de").replace(/\/+$/, "");

  if (mode === "word") {
    return translateWordWithEnrichment({ text: cleanText, sourceLang, targetLang, mode, signal, contextText }, { deeplKey, libreBase });
  }

  const providers = [];
  if (deeplKey) providers.push({ name: "deepl", run: (ctx) => translateWithDeepL(ctx, deeplKey) });
  providers.push({ name: "libretranslate", run: (ctx) => translateWithLibre(ctx, libreBase) });
  providers.push({ name: "mymemory", run: (ctx) => translateWithMyMemory(ctx) });

  const failures = [];
  for (const provider of providers) {
    try {
      const translated = safeTrim(await provider.run({ text: cleanText, sourceLang, targetLang, mode, signal }));
      if (!translated) throw new Error("empty-translation");
      if (mode !== "word" && translated.toLowerCase() === cleanText.toLowerCase()) throw new Error("same-as-source");
      console.info("[translate:provider]", { provider: provider.name, sourceLang, targetLang, mode });
      return translated;
    } catch (error) {
      failures.push({ provider: provider.name, error: String(error?.message || error) });
      console.error("[translate:error]", { provider: provider.name, error });
    }
  }

  const finalError = new Error("all-providers-failed");
  finalError.failures = failures;
  throw finalError;
}
