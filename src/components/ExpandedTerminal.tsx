import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Minimize2 } from "lucide-react";
import { Button, Dialog, DialogRoot } from "./ui";
import { scopeNativeWebOverlayRegions, useNativeWebOverlayRegion } from "../hooks/useNativeWebOverlayRegion";
import { nativeTerminalCutout, type NativeTerminalRect } from "../lib/nativeTerminalLayout";

/** WebKit masks the native surface's corners without modifying Ghostty's
 * replaceable backing layer. Only the original TerminalPane publishes geometry. */
export default function ExpandedTerminal({ children, rect, onRestore }: {
  children: ReactNode;
  rect: NativeTerminalRect | null;
  onRestore: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreControlRef = useNativeWebOverlayRegion<HTMLDivElement>(true, rect);
  // 12px outer radius minus the 1px frame border.
  const cutout = rect ? nativeTerminalCutout(rect, window.innerWidth, window.innerHeight, 11) : undefined;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) return scopeNativeWebOverlayRegions(dialog);
  }, []);

  useLayoutEffect(() => {
    const root = document.getElementById("root");
    if (!root || !cutout) return;
    const previous = root.style.clipPath;
    root.style.clipPath = cutout;
    return () => { root.style.clipPath = previous; };
  }, [cutout]);

  return (
    <DialogRoot nativeContent className="terminal-expanded-backdrop" onDismiss={onRestore}
      style={{ "--terminal-cutout": cutout ?? "none" } as CSSProperties}>
      <Dialog ref={dialogRef} className={`terminal-expanded-frame${rect ? " is-ready" : ""}`}
        aria-label="Expanded terminal">
        <div className="terminal-expand-control" ref={restoreControlRef}>
          <Button variant="icon" className="turn-pane-header-button" data-native-web-keyboard aria-label="Restore terminal" title="Restore terminal (⌘⇧Enter)" onClick={onRestore}>
            <Minimize2 size={14} aria-hidden="true" />
          </Button>
        </div>
        {children}
      </Dialog>
    </DialogRoot>
  );
}
