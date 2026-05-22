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
  const main = safeTrim(body?.responseData?.translatedText);
  const isSingleWord = ctx.mode === "word";
  if (!isSingleWord) return main;

  const alternatives = normalizeVariantList((body?.matches || []).map((m) => m?.translation));
  const combined = normalizeVariantList([main, ...alternatives]).slice(0, 3);
  if (!combined.length) return "";
  if (combined.length === 1) return combined[0];
  return combined.map((item, idx) => `${idx + 1}. ${item}`).join("\n");
}

export async function translateTextWithFallback({ text, sourceLang, targetLang, mode = "phrase", signal }) {
  const cleanText = safeTrim(text);
  if (!cleanText) return "";

  const deeplKey = safeTrim(window.__CHANKI_DEEPL_KEY__ || localStorage.getItem("chanki_deepl_key"));
  const libreBase = safeTrim(window.__CHANKI_LIBRETRANSLATE_URL__ || localStorage.getItem("chanki_libretranslate_url") || "https://libretranslate.de").replace(/\/+$/, "");

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
