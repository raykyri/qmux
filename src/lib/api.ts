import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PaneInfo, QmuxEvent, RuntimeConfig } from "../types";

export function getRuntimeConfig() {
  return invoke<RuntimeConfig>("get_runtime_config");
}

export function listPanes() {
  return invoke<PaneInfo[]>("list_panes");
}

export function spawnShell() {
  return invoke<PaneInfo>("spawn_shell");
}

export function writePane(paneId: string, data: string) {
  return invoke<void>("pane_write", { paneId, data, paste: false, submit: false });
}

export function resizePane(paneId: string, cols: number, rows: number) {
  return invoke<void>("pane_resize", { paneId, cols, rows });
}

export function killPane(paneId: string) {
  return invoke<void>("pane_kill", { paneId });
}

export function listenToEvents(onEvent: (event: QmuxEvent) => void): Promise<UnlistenFn> {
  return listen<QmuxEvent>("qmux-event", (event) => onEvent(event.payload));
}
