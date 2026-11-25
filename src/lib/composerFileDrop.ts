import type { DragDropEvent } from "@tauri-apps/api/window";

interface ComposerFileDropTarget {
  onHover: (hovering: boolean) => void;
  onDrop: (paths: string[]) => void;
}

/** References files without reading or copying their contents. */
export function droppedFileReferences(paths: readonly string[]): string {
  return [...new Set(paths)].filter(Boolean).map((path) => {
    // Reuse image previews only for paths the image-marker parser can represent.
    if (path.startsWith("/") && path === path.trim() && !/[\]\r\n]/.test(path) && /\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
      return `[Image: ${path}]`;
    }
    return `[File: ${JSON.stringify(path)}]`;
  }).join("\n");
}

export function fileDropInsertion(draft: string, start: number, end: number, paths: readonly string[]): string {
  const references = droppedFileReferences(paths);
  if (!references) return "";
  const before = start > 0 && !/\s/.test(draft[start - 1]) ? "\n" : "";
  const after = end < draft.length && !/\s/.test(draft[end]) ? "\n" : "";
  return before + references + after;
}

/** Routes native window drops to the composer under the pointer, including splits. */
export class ComposerFileDrops {
  private targets = new Map<Element, ComposerFileDropTarget>();
  private hovered: ComposerFileDropTarget | null = null;
  private hasFiles = false;

  register(element: Element, target: ComposerFileDropTarget): () => void {
    this.targets.set(element, target);
    return () => {
      if (this.hovered === target) this.setHovered(null);
      this.targets.delete(element);
    };
  }

  private setHovered(target: ComposerFileDropTarget | null) {
    if (target === this.hovered) return;
    this.hovered?.onHover(false);
    this.hovered = target;
    target?.onHover(true);
  }

  clear() {
    this.hasFiles = false;
    this.setHovered(null);
  }

  clearHover() {
    this.setHovered(null);
  }

  handle(
    event: DragDropEvent,
    scaleFactor: number,
    blocked: boolean,
    elementAtPoint: (x: number, y: number) => Element | null = (x, y) => document.elementFromPoint(x, y),
  ): boolean {
    if (event.type === "leave" || blocked) {
      this.clear();
      return false;
    }
    if (event.type === "enter" || event.type === "drop") this.hasFiles = event.paths.length > 0;
    const element = this.hasFiles
      ? elementAtPoint(event.position.x / scaleFactor, event.position.y / scaleFactor)
        ?.closest("[data-composer-file-drop]")
      : null;
    const target = element && !element.closest("[inert]") ? this.targets.get(element) ?? null : null;
    if (event.type === "drop") {
      this.clear();
      target?.onDrop(event.paths);
    } else {
      this.setHovered(target);
    }
    return target !== null;
  }
}

export const composerFileDrops = new ComposerFileDrops();
