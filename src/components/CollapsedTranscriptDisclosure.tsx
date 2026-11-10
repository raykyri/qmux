import { useId, useState } from "react";
import { Button } from "./ui";

export default function CollapsedTranscriptDisclosure({ label, text }: { label: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const title = expanded ? `Collapse ${label}` : `Show ${label}`;

  return (
    <div className={`tagged-user-instruction${expanded ? " is-expanded" : " is-collapsed"}`}>
      <Button
        className="tagged-user-instruction-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        title={title}
        onClick={() => setExpanded((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded) {
            event.stopPropagation();
            setExpanded(false);
          }
        }}
      >
        {label}
      </Button>
      {expanded ? <p id={contentId} className="turn-text is-tagged-instruction">{text}</p> : null}
    </div>
  );
}
