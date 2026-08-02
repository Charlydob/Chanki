const TEMPORARY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runtimeConfig() {
  const env = globalThis.CHANKI_ENV || {};
  return { url: String(env.VITE_GOOGLE_SHEETS_SYNC_URL || "").trim(), token: String(env.VITE_CHANKI_SYNC_TOKEN || "") };
}
function assertPayload(value, action) {
  if (!value || typeof value !== "object" || value.ok !== true || typeof value.serverTime !== "string") throw new Error(`Respuesta no válida al ${action}`);
  return value;
}
export class GoogleSheetsSyncProvider {
  constructor({ url, token, timeoutMs = 10000, retries = 2, fetchImpl = globalThis.fetch } = {}) { const config = runtimeConfig(); this.url = url ?? config.url; this.token = token ?? config.token; this.timeoutMs = timeoutMs; this.retries = retries; this.fetchImpl = fetchImpl; }
  get configured() { return Boolean(this.url && this.token); }
  async request(body) {
    if (!this.configured) throw new Error("Sincronización pendiente de configurar");
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ ...body, token: this.token }), signal: controller.signal });
        if (!response.ok) { const error = new Error(TEMPORARY_STATUS.has(response.status) ? "Servicio temporalmente no disponible" : "Solicitud de sincronización rechazada"); error.temporary = TEMPORARY_STATUS.has(response.status); throw error; }
        return assertPayload(await response.json(), body.action);
      } catch (error) { lastError = error; if (attempt >= this.retries || (!error.temporary && error.name !== "AbortError" && !(error instanceof TypeError))) break; await sleep(300 * 2 ** attempt); }
      finally { clearTimeout(timer); }
    }
    throw new Error(lastError?.name === "AbortError" ? "La sincronización tardó demasiado" : (lastError?.message || "No se pudo sincronizar"));
  }
  async testConnection() { const payload = await this.request({ action: "ping" }); return { ok: true, serverTime: payload.serverTime, sheetName: String(payload.sheetName || "") }; }
  async pullChanges(since) { const payload = await this.request({ action: "pull", ...(since ? { since } : {}) }); if (!Array.isArray(payload.cards)) throw new Error("La descarga no contiene tarjetas válidas"); return { serverTime: payload.serverTime, cards: payload.cards }; }
  async pushChanges(changes) { const payload = await this.request({ action: "push", changes }); if (!Array.isArray(payload.results)) throw new Error("La subida no contiene resultados válidos"); return { serverTime: payload.serverTime, results: payload.results }; }
}

export class VocabularySyncService {
  constructor(store, provider) { this.store = store; this.provider = provider; this.running = null; }
  sync() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; }); return this.running;
  }
  async run() {
    if (!this.provider.configured) return { ok: false, pendingConfiguration: true };
    const before = this.store.snapshot();
    if (before.queue.length) { const pushed = await this.provider.pushChanges(before.queue); this.store.acknowledge(pushed.results); }
    const pulled = await this.provider.pullChanges(before.deck.lastSuccessfulSyncAt || undefined); this.store.mergeRemote(pulled.cards);
    this.store.data.deck.lastSuccessfulSyncAt = pulled.serverTime; this.store.persist();
    return { ok: true, serverTime: pulled.serverTime };
  }
}
