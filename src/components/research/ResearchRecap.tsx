import { LoaderCircle } from "lucide-react";
import type { ResearchNodeContent } from "../../types";

export function ResearchRecapLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return (
    <p
      className={
        className
          ? `research-summary-text research-recap ${className}`
          : "research-summary-text research-recap"
      }
    >
      Summary: {trimmed}
    </p>
  );
}

/** Placeholder in the recap's own slot while a background summary job runs, so
 * the summary lands where the spinner sat rather than shifting the answer. */
export function ResearchRecapPendingLine({ className }: { className?: string }) {
  return (
    <p
      className={
        className
          ? `research-summary-text research-recap research-recap-pending ${className}`
          : "research-summary-text research-recap research-recap-pending"
      }
      role="status"
      aria-label="Generating summary"
      title="Generating summary"
    >
      <LoaderCircle className="research-spinner" size={13} aria-hidden="true" />
    </p>
  );
}

/** No reserved space for a recap that is absent and not being generated:
 * mount only a completed, current recap, or the pending placeholder. */
export default function ResearchRecap({
  content,
  pending = false,
}: {
  content: ResearchNodeContent;
  /** A background summary job is in flight for this node. */
  pending?: boolean;
}) {
  const { node, responseRevision } = content;
  const recap = node.recap;
  if ((node.kind ?? "run") !== "run" || node.status !== "complete") {
    return null;
  }
  if (
    !recap?.text.trim() ||
    !responseRevision ||
    recap.responseRevision !== responseRevision
  ) {
    return pending ? <ResearchRecapPendingLine /> : null;
  }
  return <ResearchRecapLine text={recap.text} />;
}
