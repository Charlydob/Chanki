import {
  getDailyBundle,
  getDateKey,
  markItemKnown,
  registerCardCreated,
  replaceDailyItem,
  saveVerbExerciseAnswers,
  updateItemProgress,
} from "../../lib/daily.js";

const PRONOUNS = ["ich", "du", "er/sie/es", "wir", "ihr", "sie/Sie"];
const TENSES = ["Präsens", "Perfekt", "Futur I"];

let ctx = null;

function buildMeta(item) {
  const parts = [];
  if (item.level) parts.push(item.level);
  if (item.tags?.length) parts.push(item.tags.join(" · "));
  return parts.join(" · ");
}

function cardActions(item, labelKnown = "Ya conocido") {
  return `<div class="daily-actions">
    <button class="button ghost small" data-daily-action="known" data-daily-type="${item.type}" data-daily-id="${item.id}">${labelKnown}</button>
    <button class="button ghost small" data-daily-action="replace" data-daily-type="${item.type}" data-daily-id="${item.id}">Cambiar</button>
    <button class="button small" data-daily-action="create-card" data-daily-type="${item.type}" data-daily-id="${item.id}">Crear tarjeta</button>
  </div>`;
}

function renderVerbExercise(verb) {
  const answers = ctx.verbAnswers?.[verb.id] || {};
  return TENSES.map((tense) => {
    const key = tense.toLowerCase().replace(/\s+/g, "_");
    return `<div class="daily-verb-tense">
      <h4>${tense}</h4>
      ${PRONOUNS.map((pronoun) => {
        const id = `${verb.id}_${key}_${pronoun.replace(/[^a-zA-Z]/g, "")}`;
        const value = answers?.[key]?.[pronoun] || "";
        return `<label class="field daily-verb-row"><span>${pronoun}</span><input id="${id}" data-verb-id="${verb.id}" data-tense="${key}" data-pronoun="${pronoun}" value="${value}" placeholder="Escribe aquí" /></label>`;
      }).join("")}
    </div>`;
  }).join("");
}

function findByType(type, id) {
  if (type === "noun") return ctx.items.nouns.find((n) => n.id === id);
  if (type === "verb") return ctx.items.verb?.id === id ? ctx.items.verb : null;
  if (type === "sentence") return ctx.items.sentence?.id === id ? ctx.items.sentence : null;
  return null;
}

function render() {
  if (!ctx || !ctx.elements.dailyContent) return;
  const { nouns, verb, sentence } = ctx.items;
  ctx.elements.dailyDate.textContent = ctx.dateKey;
  ctx.elements.dailyContent.innerHTML = `
    <div class="card daily-summary"><h3>Bloque diario</h3><p class="muted">2 sustantivos · 1 verbo · 1 frase</p></div>
    ${nouns.map((noun, idx) => `<article class="card daily-card">
      <p class="eyebrow">Sustantivo ${idx + 1}</p>
      <h3>${noun.article || ""} ${noun.german}</h3>
      <p>${noun.spanish}</p>
      <p class="muted">Plural: ${noun.plural || "-"}</p>
      <p class="muted">${buildMeta(noun)}</p>
      ${cardActions(noun)}
    </article>`).join("")}
    ${verb ? `<article class="card daily-card">
      <p class="eyebrow">Verbo del día</p>
      <h3>${verb.german}</h3>
      <p>${verb.spanish}</p>
      <p class="muted">${buildMeta(verb)}</p>
      <div class="daily-verb-grid">${renderVerbExercise(verb)}</div>
      ${cardActions(verb)}
    </article>` : ""}
    ${sentence ? `<article class="card daily-card">
      <p class="eyebrow">Frase del día</p>
      <h3>${sentence.german}</h3>
      <p>${sentence.spanish}</p>
      <p class="muted">${buildMeta(sentence)}</p>
      ${cardActions(sentence, "Ya conocida")}
    </article>` : ""}
  `;
}

async function persistVerbInput(input) {
  const verbId = input.dataset.verbId;
  const tense = input.dataset.tense;
  const pronoun = input.dataset.pronoun;
  if (!verbId || !tense || !pronoun) return;
  ctx.verbAnswers[verbId] = ctx.verbAnswers[verbId] || {};
  ctx.verbAnswers[verbId][tense] = ctx.verbAnswers[verbId][tense] || {};
  ctx.verbAnswers[verbId][tense][pronoun] = input.value;
  await saveVerbExerciseAnswers(ctx.getDb(), ctx.state.username, ctx.dateKey, verbId, ctx.verbAnswers[verbId]);
}

async function swap(type, id, asKnown = false) {
  const item = findByType(type, id);
  if (!item) return;
  if (asKnown) await markItemKnown(ctx.getDb(), ctx.state.username, item);
  else await updateItemProgress(ctx.getDb(), ctx.state.username, item, { known: false });
  ctx.progressItems[item.id] = { ...(ctx.progressItems[item.id] || {}), known: asKnown, seenCount: (ctx.progressItems[item.id]?.seenCount || 0) + 1, lastShownAt: Date.now() };

  const next = await replaceDailyItem(
    ctx.getDb(),
    ctx.state.username,
    ctx.dateKey,
    type,
    id,
    ctx.catalog,
    ctx.progressItems,
    ctx.bundle
  );
  if (!next) return;
  if (type === "noun") ctx.items.nouns = ctx.items.nouns.map((n) => (n.id === id ? next : n));
  if (type === "verb") ctx.items.verb = next;
  if (type === "sentence") ctx.items.sentence = next;
  if (type === "noun") ctx.bundle.nounIds = ctx.items.nouns.map((n) => n.id);
  if (type === "verb") ctx.bundle.verbId = next.id;
  if (type === "sentence") ctx.bundle.sentenceId = next.id;
  render();
  ctx.showToast("Ítem sustituido");
}

async function createCard(type, id) {
  const item = findByType(type, id);
  if (!item) return;
  const extra = type === "verb" ? ctx.verbAnswers?.[id] : null;
  const created = await ctx.createCardFromDailyItem(type, item, extra);
  if (created?.cardId) {
    await registerCardCreated(ctx.getDb(), ctx.state.username, ctx.dateKey, {
      ...created,
      dailyItemId: id,
      type,
      at: Date.now(),
    });
  }
}

async function handleClick(event) {
  const button = event.target.closest("[data-daily-action]");
  if (!button) return;
  const action = button.dataset.dailyAction;
  const type = button.dataset.dailyType;
  const id = button.dataset.dailyId;
  if (action === "known") await swap(type, id, true);
  if (action === "replace") await swap(type, id, false);
  if (action === "create-card") await createCard(type, id);
}

export async function initDailyScreen(config) {
  ctx = { ...config };
  ctx.dateKey = getDateKey();
  const daily = await getDailyBundle(ctx.getDb(), ctx.state.username, ctx.dateKey);
  ctx.bundle = daily.bundle;
  ctx.catalog = daily.catalog;
  ctx.progressItems = daily.progressItems || {};
  ctx.verbAnswers = daily.verbAnswers || {};

  ctx.items = {
    nouns: ctx.bundle.nounIds
      .map((id) => ctx.catalog.nouns.find((item) => item.id === id))
      .filter(Boolean)
      .map((item) => ({ ...item, type: "noun" })),
    verb: ctx.catalog.verbs.find((item) => item.id === ctx.bundle.verbId)
      ? { ...ctx.catalog.verbs.find((item) => item.id === ctx.bundle.verbId), type: "verb" }
      : null,
    sentence: ctx.catalog.sentences.find((item) => item.id === ctx.bundle.sentenceId)
      ? { ...ctx.catalog.sentences.find((item) => item.id === ctx.bundle.sentenceId), type: "sentence" }
      : null,
  };

  ctx.elements.dailyContent?.removeEventListener("click", handleClick);
  ctx.elements.dailyContent?.addEventListener("click", handleClick);
  ctx.elements.dailyContent?.addEventListener("input", (event) => {
    const input = event.target.closest("input[data-verb-id]");
    if (!input) return;
    persistVerbInput(input);
  });
  render();
}
