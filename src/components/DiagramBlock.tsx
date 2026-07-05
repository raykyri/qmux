import { isValidElement, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

// Renders fenced ```mermaid and ```dot/```graphviz blocks from transcript markdown as SVG,
// entirely in the webview (no server, no external fetch). Both libraries are dynamically
// imported so they land in their own chunk and only load once a diagram actually scrolls
// into view. On any parse/render failure we fall back to the raw source so no content is lost.

type DiagramLang = "mermaid" | "dot";

// Maps a fenced-block info string (react-markdown hands it to us as `language-xxx`) to the
// diagram engine that should handle it, or null for ordinary code blocks.
export function diagramLangFromClassName(className?: string): DiagramLang | null {
  if (!className) return null;
  const match = /language-([\w-]+)/.exec(className);
  const lang = match?.[1]?.toLowerCase();
  if (lang === "mermaid") return "mermaid";
  if (lang === "dot" || lang === "graphviz" || lang === "gv") return "dot";
  return null;
}

// Flattens the react-markdown children of a <code> element back into its source text.
export function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidPromise: Promise<MermaidApi> | null = null;
function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const api = mod.default as unknown as MermaidApi;
      api.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return api;
    });
  }
  return mermaidPromise;
}

type Viz = { renderString: (src: string, options?: { format?: string }) => string };

let vizPromise: Promise<Viz> | null = null;
function getViz(): Promise<Viz> {
  if (!vizPromise) {
    vizPromise = import("@viz-js/viz").then((mod) => mod.instance() as unknown as Promise<Viz>);
  }
  return vizPromise;
}

// Both SVGs are injected via dangerouslySetInnerHTML, and the source is agent-authored, so
// scrub the vectors that DOM injection opens up: <script> tags, inline on* event handlers, and
// javascript: URLs (Graphviz turns DOT `URL="..."` into clickable <a xlink:href> links, which
// would otherwise bypass the safeHref guard the rest of the app routes links through). Mermaid's
// strict mode already sanitizes; running this over its output too is cheap defense in depth.
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/((?:xlink:)?href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2");
}

let mermaidSeq = 0;

async function renderDiagram(lang: DiagramLang, code: string): Promise<string> {
  if (lang === "mermaid") {
    const mermaid = await getMermaid();
    const id = `qmux-mermaid-${mermaidSeq++}`;
    const { svg } = await mermaid.render(id, code);
    return sanitizeSvg(svg);
  }
  const viz = await getViz();
  return sanitizeSvg(viz.renderString(code, { format: "svg" }));
}

// Defers work until the element is near the viewport so long transcripts don't pay to build
// every diagram (and the WASM/mermaid chunks) up front.
function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, inView]);
  return inView;
}

type RenderState =
  | { status: "loading" }
  | { status: "done"; svg: string }
  | { status: "error"; error: string };

export default function DiagramBlock({ lang, code }: { lang: DiagramLang; code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "loading" });
  const [showSource, setShowSource] = useState(false);
  const inView = useInView(containerRef);
  const source = code.replace(/\n+$/, "");

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    setState({ status: "loading" });
    renderDiagram(lang, source)
      .then((svg) => {
        if (!cancelled) setState({ status: "done", svg });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ status: "error", error: message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inView, lang, source]);

  const label = lang === "dot" ? "graphviz" : "mermaid";

  return (
    <div className="turn-diagram" ref={containerRef} data-lang={lang}>
      <div className="turn-diagram-bar">
        <span className="turn-diagram-lang">{label}</span>
        <button
          type="button"
          className="turn-diagram-toggle"
          onClick={() => setShowSource((prev) => !prev)}
        >
          {showSource ? "Diagram" : "Source"}
        </button>
      </div>
      {showSource ? (
        <pre className="turn-diagram-source">
          <code>{source}</code>
        </pre>
      ) : state.status === "error" ? (
        <div className="turn-diagram-error">
          <div className="turn-diagram-error-msg">
            Couldn’t render {label} diagram: {state.error}
          </div>
          <pre className="turn-diagram-source">
            <code>{source}</code>
          </pre>
        </div>
      ) : state.status === "done" ? (
        <div
          className="turn-diagram-svg"
          data-lang={lang}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <div className="turn-diagram-loading">Rendering {label} diagram…</div>
      )}
    </div>
  );
}
