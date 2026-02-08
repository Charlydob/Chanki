const clickHandlers = {};
let clickDelegationBound = false;

export function $(sel, root = document) {
  return root?.querySelector?.(sel) || null;
}

function resolveElement(selOrEl) {
  if (!selOrEl) return null;
  if (typeof selOrEl === "string") return $(selOrEl);
  return selOrEl;
}

export function setText(selOrEl, text) {
  const el = resolveElement(selOrEl);
  if (!el) return;
  el.textContent = text;
}

export function show(selOrEl) {
  const el = resolveElement(selOrEl);
  if (!el) return;
  el.classList?.remove("hidden");
}

export function hide(selOrEl) {
  const el = resolveElement(selOrEl);
  if (!el) return;
  el.classList?.add("hidden");
}

export function toast(msg, type = "") {
  const container = $("#toast-container");
  if (!container) return;
  const item = document.createElement("div");
  item.className = `toast${type ? ` ${type}` : ""}`;
  item.textContent = msg;
  container.appendChild(item);
  setTimeout(() => item.remove(), 2500);
}

export function onClick(action, handler) {
  clickHandlers[action] = handler;
  if (clickDelegationBound) return;
  clickDelegationBound = true;
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const fn = clickHandlers[el.dataset.action];
    if (typeof fn === "function") {
      fn(e, el);
    }
  });
}
