import claudeModelIconUrl from "../assets/model-icons/claude-ai.svg";
import openAiModelIconUrl from "../assets/model-icons/openai.svg";
import openCodeModelIconUrl from "../assets/model-icons/opencode-dark.svg";
import grokModelIconUrl from "../assets/model-icons/grok.svg";
import { CLAUDE_ADAPTER_ID } from "../adapters/claude";
import { CODEX_ADAPTER_ID } from "../adapters/codex";
import { GROK_ADAPTER_ID } from "../adapters/grok";
import { OPENCODE_ADAPTER_ID } from "../adapters/opencode";

/* Adapter icons for LauncherSelect chips — shared by the Home launcher and the
   new-research composer so every agent picker renders the same marks. */
export const ADAPTER_ICON_BY_ID: Record<string, string> = {
  [CLAUDE_ADAPTER_ID]: claudeModelIconUrl,
  [CODEX_ADAPTER_ID]: openAiModelIconUrl,
  [OPENCODE_ADAPTER_ID]: openCodeModelIconUrl,
  [GROK_ADAPTER_ID]: grokModelIconUrl,
};

// Per-adapter icon tweaks: Codex's mark is dark-on-transparent (invert it) and
// both it and OpenCode render optically large at 14px (step them down).
export function adapterIconClassName(adapterId: string): string | undefined {
  if (adapterId === CODEX_ADAPTER_ID) {
    return "is-mono-light is-compact";
  }
  if (adapterId === OPENCODE_ADAPTER_ID) {
    return "is-compact";
  }
  return undefined;
}
