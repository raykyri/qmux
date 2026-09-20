import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Upload } from "lucide-react";
import { readMarkdownDocumentFile } from "../../lib/api";
import { isMarkdownDocumentPath } from "../../lib/researchDocuments";
import { estimateTokenCount } from "../../lib/tokenEstimate";
import {
  Button,
  DialogActions,
  DialogForm,
  DialogRoot,
  DialogTitle,
  Textarea,
} from "../ui";

const ONE_AT_A_TIME = "Import one Markdown report at a time.";
/** Matches the backend's own wording so the two rejections read alike. */
const WRONG_EXTENSION = "only .md and .markdown files can be imported";

/** The backend rejects a read with a plain string that explains itself (the
 * home-directory confinement, the byte cap, the extension). Show it verbatim
 * rather than replacing it with a generic failure. */
function readFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Home header's report import: a file picker plus a drop target over the
 * feed, then a dialog for the prompt that produced the report. Both drop paths
 * are live — the DOM one for a webview drag, and the native window event Tauri
 * delivers instead when the drag comes from Finder, whose payload carries
 * filesystem paths the backend reads under its own confinement. */
export default function ResearchReportImport({
  dropTarget,
  onImport,
  onError,
}: {
  /** The feed scroller that accepts a dropped report. */
  dropTarget: RefObject<HTMLDivElement | null>;
  onImport: (markdown: string, prompt: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // A second drop while a report is staged (or being read) must not replace it
  // under the open dialog, so staging is single-occupancy until the dialog
  // closes.
  const occupied = useRef(false);
  const mounted = useRef(true);
  const [report, setReport] = useState<{ name: string; markdown: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stage(name: string, read: () => Promise<string>) {
    if (occupied.current) return;
    if (!isMarkdownDocumentPath(name)) {
      onError(WRONG_EXTENSION);
      return;
    }
    occupied.current = true;
    try {
      const markdown = await read();
      if (!markdown.trim()) throw new Error("The report is empty.");
      if (!mounted.current) return;
      setPrompt("");
      setError(null);
      setReport({ name, markdown });
    } catch (err) {
      occupied.current = false;
      if (mounted.current) onError(readFailureMessage(err));
    }
  }
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    mounted.current = true;
    const target = dropTarget.current;
    if (!target) return;
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      if (files.length !== 1) {
        onError(ONE_AT_A_TIME);
        return;
      }
      const file = files[0];
      void stageRef.current(file.name, () => file.text());
    };
    target.addEventListener("dragover", dragOver);
    target.addEventListener("drop", drop);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void getCurrentWebview()
        .onDragDropEvent(({ payload }) => {
          if (disposed || payload.type !== "drop") return;
          // Hit-test the native drop against the feed's own box: the window
          // event fires wherever it landed, and the sidebar's document import
          // owns its own region. Physical pixels come in; CSS pixels come out.
          const bounds = target.getBoundingClientRect();
          const scale = globalThis.devicePixelRatio || 1;
          const x = payload.position.x / scale;
          const y = payload.position.y / scale;
          if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
          if (payload.paths.length !== 1) {
            onError(ONE_AT_A_TIME);
            return;
          }
          const path = payload.paths[0];
          void stageRef.current(path.split(/[\\/]/).pop() ?? path, () =>
            readMarkdownDocumentFile(path),
          );
        })
        .then((cleanup) => {
          if (disposed) cleanup();
          else unlisten = cleanup;
        })
        .catch((err: unknown) => {
          if (!disposed) onError(readFailureMessage(err));
        });
    }
    return () => {
      mounted.current = false;
      disposed = true;
      unlisten?.();
      target.removeEventListener("dragover", dragOver);
      target.removeEventListener("drop", drop);
    };
  }, [dropTarget, onError]);

  // Grow the prompt field to fit its committed value. Measuring in onChange can
  // catch WebKit between its native edit and React restoring the controlled
  // value; useLayoutEffect keeps value and height in one pre-paint commit.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt, report]);

  function close() {
    if (busy) return;
    setReport(null);
    setError(null);
    occupied.current = false;
    buttonRef.current?.focus();
  }

  return (
    <>
      <Button
        ref={buttonRef}
        className="research-import-button"
        title="Import a Markdown report"
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={15} aria-hidden="true" /> Import report
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,text/markdown"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void stage(file.name, () => file.text());
        }}
      />
      {report ? (
        <DialogRoot onDismiss={close} dismissDisabled={busy}>
          <DialogForm
            className="research-import-dialog"
            aria-labelledby="research-import-title"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || !prompt.trim()) return;
              setBusy(true);
              setError(null);
              try {
                await onImport(report.markdown, prompt.trim());
                if (mounted.current) {
                  setReport(null);
                  occupied.current = false;
                  buttonRef.current?.focus();
                }
              } catch (err) {
                if (mounted.current) setError(readFailureMessage(err));
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            <DialogTitle id="research-import-title">Import report</DialogTitle>
            <label className="research-import-field" htmlFor="research-import-prompt">
              <span>Prompt that generated this report</span>
              <Textarea
                ref={promptRef}
                id="research-import-prompt"
                data-dialog-initial-focus
                required
                rows={3}
                value={prompt}
                disabled={busy}
                placeholder="Paste the original research prompt…"
                onChange={(event) => setPrompt(event.currentTarget.value)}
              />
            </label>
            <p className="research-import-file">
              <span className="research-import-filename">{report.name}</span>
              <span className="research-import-tokens">
                {estimateTokenCount(report.markdown).toLocaleString()} tokens (estimated)
              </span>
            </p>
            {error ? (
              <p className="confirm-dialog-error" role="alert">
                {error}
              </p>
            ) : null}
            <DialogActions>
              <Button type="button" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" tone="primary" disabled={busy || !prompt.trim()}>
                {busy ? "Importing…" : "Import report"}
              </Button>
            </DialogActions>
          </DialogForm>
        </DialogRoot>
      ) : null}
    </>
  );
}
