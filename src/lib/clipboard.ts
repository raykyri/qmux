import {
  readText as readTauriClipboardText,
  writeText as writeTauriClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";

export async function readClipboardText() {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      return (await readTauriClipboardText()) ?? "";
    } catch {
      // Fall through to the web clipboard path.
    }
  }
  return (await navigator.clipboard?.readText?.()) ?? "";
}

// Copy text to the clipboard. The native Tauri path comes first: WKWebView's
// async Clipboard API is focus- and permission-sensitive, and the final
// execCommand fallback steals focus to an off-screen textarea.
export async function writeClipboardText(text: string) {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      await writeTauriClipboardText(text);
      return;
    } catch {
      // Fall through to the web clipboard paths.
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy command for WebViews without clipboard permission.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy command was rejected");
    }
  } finally {
    textarea.remove();
  }
}
