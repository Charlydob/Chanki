const APP_STORAGE_PREFIX = "chanki_";

function collectAppStorageKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(APP_STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
}

function resetLocalDataAndReload() {
  const keys = collectAppStorageKeys();
  keys.forEach((key) => localStorage.removeItem(key));
  window.location.reload();
}

function renderBootError(errorLike) {
  const error = errorLike instanceof Error ? errorLike : new Error(String(errorLike || "Error desconocido"));
  const appRoot = document.getElementById("app") || document.body;
  appRoot.innerHTML = `
    <section class="boot-error" role="alert">
      <h1>La app no pudo arrancar</h1>
      <p>Se produjo un error crítico al iniciar.</p>
      <div class="row">
        <button id="boot-retry" class="button" type="button">Reintentar</button>
        <button id="boot-reset" class="button ghost" type="button">Reset local data</button>
      </div>
      <p class="muted">${error.message || "Sin mensaje"}</p>
      <details>
        <summary>Stacktrace</summary>
        <pre>${error.stack || "No stack disponible"}</pre>
      </details>
    </section>
  `;

  const overlay = document.getElementById("overlay");
  if (overlay) overlay.classList.add("hidden");

  document.getElementById("boot-retry")?.addEventListener("click", () => {
    window.location.reload();
  });
  document.getElementById("boot-reset")?.addEventListener("click", resetLocalDataAndReload);
}

function normalizeUnhandled(errorEvent) {
  if (errorEvent?.reason instanceof Error) return errorEvent.reason;
  if (errorEvent?.error instanceof Error) return errorEvent.error;
  if (errorEvent?.message) return new Error(errorEvent.message);
  return new Error(String(errorEvent?.reason || errorEvent || "Error no controlado"));
}

window.__CHANKI_RENDER_BOOT_ERROR__ = renderBootError;

window.addEventListener("error", (event) => {
  const error = normalizeUnhandled(event);
  console.error("[boot:error]", error);
  renderBootError(error);
});

window.addEventListener("unhandledrejection", (event) => {
  const error = normalizeUnhandled(event);
  console.error("[boot:unhandledrejection]", error);
  renderBootError(error);
});

(async function safeBoot() {
  try {
    const appModule = await import("./app.js");
    if (typeof appModule?.startApp === "function") {
      await appModule.startApp();
    }
  } catch (error) {
    console.error("[boot:init]", error);
    renderBootError(error);
  }
})();
