import type { SidebarMode } from "./sidebarMode";

export type SidebarScrollRegion = "terminal" | "research" | "researchTerminals";

export function sidebarScrollRegionsForMode(mode: SidebarMode): SidebarScrollRegion[] {
  return mode === "research" ? ["research", "researchTerminals"] : ["terminal"];
}

export function activeSidebarScrollRegion(
  mode: SidebarMode,
  activeSurface: "pane" | "research",
): SidebarScrollRegion {
  if (mode === "terminal") {
    return "terminal";
  }
  return activeSurface === "research" ? "research" : "researchTerminals";
}
