import { renderFolders } from "../screens/folders.js";

export function mountFoldersView(root = null) {
  if (root) {
    root.innerHTML = root.innerHTML || "";
  }
  renderFolders();
}
