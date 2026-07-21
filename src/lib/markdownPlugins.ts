import type { Options } from "react-markdown";
import rehypeMathjax from "rehype-mathjax/svg";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type PluginList = NonNullable<Options["remarkPlugins"]>;

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: unknown;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

// remark-math alone mis-handles two shapes that dominate agent transcripts:
//
// - Prices: in "costs $5 and $10 more" it treats "5 and" as inline math.
//   Mirror GitHub's rule — when the character right after a closing $ is a
//   digit, the pair reads as currency, so the node reverts to literal text.
// - Single-line display math: LLMs routinely emit "$$…$$" on one line, but
//   micromark only accepts fenced ($$ on its own lines) math as display, so
//   the one-liner parses as inline math inside a paragraph. A paragraph that
//   is exactly one $$-delimited math node gets promoted to a display block.
// The same mdast shape mdast-util-math produces for fenced $$ blocks, so
// remark-rehype and rehype-mathjax treat promoted nodes identically.
function displayMathNode(value: string): MdastNode {
  return {
    type: "math",
    value,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value }],
        },
      ],
    },
  } as MdastNode;
}

function remarkTranscriptMathTweaks() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : String(file.value ?? "");
    const visit = (node: MdastNode) => {
      const children = node.children;
      if (!children) {
        return;
      }
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.type === "paragraph" && child.children?.length === 1) {
          const only = child.children[0];
          const start = only.position?.start.offset;
          const end = only.position?.end.offset;
          if (
            only.type === "inlineMath" &&
            start !== undefined &&
            end !== undefined &&
            source.startsWith("$$", start) &&
            source.slice(end - 2, end) === "$$"
          ) {
            children[i] = displayMathNode(only.value ?? "");
            continue;
          }
        }
        if (child.type === "inlineMath") {
          const next = children[i + 1];
          if (next?.type === "text" && /^\d/.test(next.value ?? "")) {
            children[i] = { type: "text", value: `$${child.value ?? ""}$` };
            continue;
          }
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

// Shared by the app's transcript/research Markdown and the public site's
// server-rendered pages so both surfaces parse identically. remark-math
// recognizes $…$ / $$…$$ TeX; rehype-mathjax renders it to self-contained
// inline SVG at parse time — no webfonts, no external fetches — and the
// glyphs use currentColor so they follow the surrounding text color.
export const transcriptRemarkPlugins: PluginList = [
  remarkMath,
  remarkTranscriptMathTweaks,
  remarkGfm,
  remarkBreaks,
];

export const transcriptRehypePlugins: PluginList = [rehypeMathjax];
