import type { ReactNode } from "react";
import type { ResearchMessageAttachment } from "../../types";
import TranscriptMarkdown, {
  type OversizedMarkdownPolicy,
} from "../TranscriptMarkdown";
import { TweetEmbed } from "./TweetEmbed";

type ResearchProseVariant = "body" | "compact";

/** Research-owned adapter around the generic transcript Markdown renderer.
 * Typography is selected on the renderer itself instead of inherited from a
 * page-layout ancestor, so the same semantic content cannot change scale when
 * it moves between Home, a run, and an imported conversation. */
export function ResearchMarkdown({
  text,
  className,
  variant = "body",
  inline = false,
  oversizedContent,
}: {
  text: string;
  className?: string;
  variant?: ResearchProseVariant;
  inline?: boolean;
  oversizedContent?: OversizedMarkdownPolicy;
}) {
  const proseClassName = `research-prose research-prose--${variant}${
    className ? ` ${className}` : ""
  }`;
  return (
    <TranscriptMarkdown
      text={text}
      className={proseClassName}
      imageBehavior="open"
      inline={inline}
      oversizedContent={oversizedContent}
    />
  );
}

/** Shared authored-user-message wrapper. Context-specific callers own only
 * placement; this primitive keeps semantic and typography composition aligned. */
export function ResearchUserMessage({
  children,
  className,
  as: Element = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "article" | "div";
}) {
  return (
    <Element className={`research-user-message${className ? ` ${className}` : ""}`}>
      {children}
    </Element>
  );
}

/** Presentation-only removal of resolved tweet URLs occupying the message's
 * trailing URL block. The persisted prompt is never rewritten. */
export function visibleResearchPrompt(
  prompt: string,
  attachments: ResearchMessageAttachment[] = [],
): string {
  let visible = prompt;
  for (const attachment of [...attachments].reverse()) {
    if (
      attachment.status !== "resolved" ||
      attachment.placement !== "trailing" ||
      !attachment.tweet
    ) {
      continue;
    }
    const trimmedEnd = visible.trimEnd();
    if (!trimmedEnd.endsWith(attachment.sourceUrl)) {
      continue;
    }
    visible = trimmedEnd.slice(0, -attachment.sourceUrl.length).trimEnd();
  }
  return visible;
}

/** One authored research message: the visible prompt text plus any resolved
 * tweet attachments, rendered as embeds below it. */
export function ResearchMessageBody({
  prompt,
  attachments = [],
  renderPrompt,
}: {
  prompt: string;
  attachments?: ResearchMessageAttachment[];
  renderPrompt?: (content: ReactNode) => ReactNode;
}) {
  const visiblePrompt = visibleResearchPrompt(prompt, attachments);
  const tweets = attachments.flatMap((attachment) =>
    attachment.status === "resolved" && attachment.tweet ? [attachment.tweet] : [],
  );
  return (
    <>
      {visiblePrompt ? (
        renderPrompt ? (
          renderPrompt(<ResearchMarkdown text={visiblePrompt} />)
        ) : (
          <ResearchMarkdown text={visiblePrompt} />
        )
      ) : null}
      {tweets.length > 0 ? (
        <div className={`research-message-attachments${visiblePrompt ? " has-prompt" : ""}`}>
          {tweets.map((tweet, index) => (
            <div className="research-message-attachment" key={`${tweet.id}:${index}`}>
              <TweetEmbed tweet={tweet} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
