const MAX_LOGS = 300;
const LOG_KEY = "chunkyDebugLogs";

if (!window[LOG_KEY]) window[LOG_KEY] = [];

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const state = {
  open: false,
  mounted: false,
  needsRender: false,
  button: null,
  panel: null,
  list: null,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function ts(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function toText(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ""}`.trim();
      try { return JSON.stringify(arg); } catch (_) { return String(arg); }
    })
    .join(" ");
}

function pushEntry(type, args) {
  const logs = window[LOG_KEY];
  logs.push({ type, time: ts(), text: toText(args) });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  scheduleRender();
}

function scheduleRender() {
  if (!state.open || !state.list || state.needsRender) return;
  state.needsRender = true;
  requestAnimationFrame(() => {
    state.needsRender = false;
    renderLogs();
  });
}

function renderLogs() {
  if (!state.list) return;
  const logs = window[LOG_KEY];
  const frag = document.createDocumentFragment();
  for (const item of logs) {
    const row = document.createElement("div");
    row.className = `chunky-debug-log chunky-debug-log--${item.type}`;
    row.textContent = `[${item.time}] ${item.type.toUpperCase()} ${item.text}`;
    frag.appendChild(row);
  }
  state.list.innerHTML = "";
  state.list.appendChild(frag);
  state.list.scrollTop = state.list.scrollHeight;
}

function copyLogs() {
  const text = window[LOG_KEY].map((item) => `[${item.time}] ${item.type.toUpperCase()} ${item.text}`).join("\n");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => originalConsole.warn("No se pudo copiar logs"));
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function mountUi() {
  if (state.mounted || !document.body) return;
  state.mounted = true;

  const button = document.createElement("button");
  button.className = "chunky-debug-fab";
  button.type = "button";
  button.setAttribute("aria-label", "Abrir consola debug");
  button.textContent = ">_";

  const panel = document.createElement("section");
  panel.className = "chunky-debug-panel hidden";
  panel.innerHTML = `
    <div class="chunky-debug-panel__head">
      <strong>Debug</strong>
      <div class="chunky-debug-panel__actions">
        <button type="button" data-action="copy">Copiar</button>
        <button type="button" data-action="clear">Limpiar</button>
        <button type="button" data-action="close">✕</button>
      </div>
    </div>
    <div class="chunky-debug-panel__logs"></div>
  `;

  const list = panel.querySelector(".chunky-debug-panel__logs");

  button.addEventListener("click", () => {
    state.open = !state.open;
    panel.classList.toggle("hidden", !state.open);
    if (state.open) renderLogs();
  });

  panel.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (!action) return;
    if (action === "close") {
      state.open = false;
      panel.classList.add("hidden");
    }
    if (action === "clear") {
      window[LOG_KEY] = [];
      renderLogs();
    }
    if (action === "copy") copyLogs();
  });

  document.body.appendChild(button);
  document.body.appendChild(panel);
  state.button = button;
  state.panel = panel;
  state.list = list;
}

console.log = (...args) => {
  originalConsole.log(...args);
  pushEntry("log", args);
};

console.warn = (...args) => {
  originalConsole.warn(...args);
  pushEntry("warn", args);
};

console.error = (...args) => {
  originalConsole.error(...args);
  pushEntry("error", args);
};

window.addEventListener("error", (event) => {
  pushEntry("error", ["runtime", event.message, event.filename, `:${event.lineno}:${event.colno}`]);
});

window.addEventListener("unhandledrejection", (event) => {
  pushEntry("error", ["unhandledrejection", event.reason]);
});

window.chunkyDebug = (...args) => {
  console.log(...args);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountUi, { once: true });
} else {
  mountUi();
}

pushEntry("log", ["[debug-console] ready"]);
