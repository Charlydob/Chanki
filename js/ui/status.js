import { $, setText } from "./dom.js";

export function setStatus(text) {
  const el = $("[data-role='status']") || $("#status");
  setText(el, text);
}
