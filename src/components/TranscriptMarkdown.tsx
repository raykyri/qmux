import {
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ComponentPropsWithoutRef,
  ReactElement,
  ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { placePanePopover, turnPaneRectFrom } from "../lib/appHelpers";
import { writeClipboardText } from "../lib/clipboard";
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

const CODE_MENU_PREFERRED_WIDTH = 180;

function MarkdownCodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [wrap, setWrap] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { height } = popover.getBoundingClientRect();
    setPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width: CODE_MENU_PREFERRED_WIDTH, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "end",
        prefer: "below",
      }),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    positionMenu();
    const onReflow = () => positionMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, positionMenu]);

  return (
    <div className={`turn-markdown-code-block${wrap ? " is-wrapped" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="turn-markdown-code-menu-trigger"
        title="Code block options"
        aria-label="Code block options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Ellipsis aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="turn-title-menu-popover turn-markdown-code-menu-popover"
              role="menu"
              aria-label="Code block options"
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      maxHeight: pos.maxHeight,
                      width: Math.min(CODE_MENU_PREFERRED_WIDTH, pos.maxWidth),
                      maxWidth: pos.maxWidth,
                    }
                  : { left: -9999, top: -9999 }
              }
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={wrap}
                className="turn-title-menu-item"
                onClick={() => {
                  setWrap((value) => !value);
                  setOpen(false);
                }}
              >
                {wrap ? "Unwrap code block" : "Wrap code block"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="turn-title-menu-item"
                onClick={() => {
                  setOpen(false);
                  void writeClipboardText(nodeText(children));
                }}
              >
                Copy code block
              </button>
            </div>,
            document.body,
          )
        : null}
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
  /** Cap on what the plain-text fallback puts in the DOM. Laying out a single
   * multi-megabyte text node freezes the interface as surely as parsing it,
   * so text beyond the cap is elided with a truncation notice. */
  maxDisplayCharacters?: number;
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
    const displayLimit = oversizedContent.maxDisplayCharacters;
    const shown =
      displayLimit !== undefined && text.length > displayLimit
        ? `${text.slice(0, displayLimit)}\n… (truncated: showing ${displayLimit.toLocaleString()} of ${text.length.toLocaleString()} characters)`
        : text;
    return (
      <pre className={oversizedContent.fallbackClassName ?? "research-plaintext"}>{shown}</pre>
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
