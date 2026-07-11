import { createContext, isValidElement, memo, useContext, useState } from "react";
import type {
  ComponentPropsWithoutRef,
  ReactElement,
  ReactNode,
} from "react";
import { WrapText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { safeHref } from "../lib/links";
import DiagramBlock, { diagramLangFromClassName, nodeText } from "./DiagramBlock";

// Shared by ordinary transcript Markdown and research documents. The provider
// keeps link closures stable above memoized message items while giving ordinary
// links and links injected into diagram SVGs exactly the same behavior.
export interface LinkActions {
  openLink: (url: string) => void;
  openLinkMenu: (url: string, x: number, y: number) => void;
}

const LinkActionsContext = createContext<LinkActions>({
  openLink: () => undefined,
  openLinkMenu: () => undefined,
});

export function TranscriptLinkActionsProvider({
  actions,
  children,
}: {
  actions: LinkActions;
  children: ReactNode;
}) {
  return <LinkActionsContext.Provider value={actions}>{children}</LinkActionsContext.Provider>;
}

function MarkdownLink({ href, ...props }: ComponentPropsWithoutRef<"a">) {
  const { openLink, openLinkMenu } = useContext(LinkActionsContext);
  const safe = safeHref(href);
  if (!safe) {
    return <span {...props} />;
  }
  return (
    <a
      {...props}
      href={safe}
      onClick={(event) => {
        event.preventDefault();
        openLink(safe);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        openLinkMenu(safe, event.clientX, event.clientY);
      }}
    />
  );
}

function BlockedMarkdownImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const { openLink, openLinkMenu } = useContext(LinkActionsContext);
  const safe = safeHref(src);
  if (!safe) {
    return alt ? <span>{alt}</span> : null;
  }
  return (
    <button
      type="button"
      className="research-blocked-image"
      onClick={() => openLink(safe)}
      onContextMenu={(event) => {
        event.preventDefault();
        openLinkMenu(safe, event.clientX, event.clientY);
      }}
    >
      {alt ? `Open image: ${alt}` : "Open external image"}
    </button>
  );
}

function MarkdownDiagramBlock({ lang, code }: { lang: "mermaid" | "dot"; code: string }) {
  const { openLink, openLinkMenu } = useContext(LinkActionsContext);
  return (
    <DiagramBlock lang={lang} code={code} openLink={openLink} openLinkMenu={openLinkMenu} />
  );
}

function MarkdownCodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [wrap, setWrap] = useState(false);
  const label = wrap ? "Turn off line wrap" : "Turn on line wrap";
  return (
    <div className={`turn-markdown-code-block${wrap ? " is-wrapped" : ""}`}>
      <button
        type="button"
        className={`turn-markdown-code-wrap-toggle${wrap ? " is-active" : ""}`}
        title={label}
        aria-label={label}
        aria-pressed={wrap}
        onClick={() => setWrap((value) => !value)}
      >
        <WrapText aria-hidden="true" />
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) => <MarkdownLink href={href} {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="turn-markdown-table-wrap">
      <table {...props} />
    </div>
  ),
  pre: ({ node: _node, children, ...props }) => {
    const codeElement = isValidElement(children)
      ? (children as ReactElement<{ className?: string; children?: ReactNode }>)
      : null;
    const lang = diagramLangFromClassName(codeElement?.props.className);
    if (codeElement && lang) {
      return <MarkdownDiagramBlock lang={lang} code={nodeText(codeElement.props.children)} />;
    }
    return <MarkdownCodeBlock {...props}>{children}</MarkdownCodeBlock>;
  },
};

const researchMarkdownComponents: Components = {
  ...markdownComponents,
  img: ({ node: _node, ...props }) => <BlockedMarkdownImage {...props} />,
};

export interface OversizedMarkdownPolicy {
  maxCharacters: number;
  fallbackClassName?: string;
}

interface TranscriptMarkdownProps {
  text: string;
  className?: string;
  imageBehavior?: "render" | "open";
  oversizedContent?: OversizedMarkdownPolicy;
}

// Memoized because ReactMarkdown re-parses on every render and callers rerender
// far more often than their text changes (streaming polls deliver fresh block
// objects whose `text` is value-equal). `text` is a primitive, so the default
// shallow compare skips the parse; link handling stays live because MarkdownLink
// reads its actions through context, which bypasses the memo. Callers must pass
// a stable `oversizedContent` object or the compare degrades to identity.
export default memo(function TranscriptMarkdown({
  text,
  className = "",
  imageBehavior = "render",
  oversizedContent,
}: TranscriptMarkdownProps) {
  if (oversizedContent && text.length > oversizedContent.maxCharacters) {
    return (
      <pre className={oversizedContent.fallbackClassName ?? "research-plaintext"}>{text}</pre>
    );
  }
  return (
    <div className={`turn-markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        components={imageBehavior === "open" ? researchMarkdownComponents : markdownComponents}
        remarkPlugins={[remarkGfm, remarkBreaks]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
