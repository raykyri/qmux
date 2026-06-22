import { LoaderCircle, Mic } from "lucide-react";
import type { Dictation } from "../useDictation";
import { dictationErrorMessage } from "../useDictation";

// The mic toggle that drives live voice dictation. Shared by the right-pane
// composer and the launcher so the recording/loading/error states, tooltip, and
// keyboard handling stay identical; only placement (via `className`) differs.
// Renders nothing where the environment can't run local dictation.
export default function DictationMicButton({
  dictation,
  className,
}: {
  dictation: Dictation;
  className?: string;
}) {
  if (!dictation.supported) {
    return null;
  }
  const { listening, loading, error, progress } = dictation;
  const title = error
    ? dictationErrorMessage(error)
    : loading
      ? progress != null
        ? `Loading dictation model… ${Math.round(progress)}%`
        : "Loading dictation model…"
      : listening
        ? "Stop dictation"
        : "Start dictation";
  return (
    <button
      type="button"
      className={`dictation-mic-btn${listening ? " is-listening" : ""}${
        loading ? " is-loading" : ""
      }${error ? " is-errored" : ""}${className ? ` ${className}` : ""}`}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      aria-pressed={listening}
      title={title}
      // Don't steal focus from the composer — keep the caret put so dictation
      // lands where the user left off.
      onMouseDown={(event) => event.preventDefault()}
      onClick={dictation.toggle}
    >
      {loading ? (
        <LoaderCircle size={15} aria-hidden="true" />
      ) : (
        <Mic size={15} aria-hidden="true" />
      )}
    </button>
  );
}
