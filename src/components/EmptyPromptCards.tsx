import { useEffect, useId, useRef, useState } from "react";
import { listSavedPrompts } from "../lib/api";
import { listenToPromptLibraryChanged, requestPromptAction } from "../lib/promptLibrary";
import type { SavedPrompt } from "../types";
import { Button } from "./ui";
import PromptLibraryMenu from "./PromptLibraryMenu";
import { PromptOptionsMenu } from "./PromptOptionsMenu";

interface EmptyPromptCardsProps {
  projectDir: string | null;
  onInsert: (text: string) => void;
  promptLibraryAgentId?: string | null;
}

export default function EmptyPromptCards({
  projectDir,
  onInsert,
  promptLibraryAgentId,
}: EmptyPromptCardsProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const localLibraryId = useId();
  const libraryId = promptLibraryAgentId ?? localLibraryId;
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    prompt: SavedPrompt;
    point: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    let active = true;
    let loadId = 0;
    const refresh = () => {
      const currentLoad = ++loadId;
      void listSavedPrompts(projectDir)
        .then((library) => {
          if (active && currentLoad === loadId) setPrompts(library.prompts);
        })
        .catch(() => {
          if (active && currentLoad === loadId) setPrompts([]);
        });
    };
    setPrompts([]);
    refresh();
    const stopListening = listenToPromptLibraryChanged(refresh);
    return () => {
      active = false;
      stopListening();
    };
  }, [projectDir]);

  const runPromptAction = (action: "edit" | "delete") => {
    const returnFocusTo = contextTriggerRef.current;
    if (!contextMenu || !returnFocusTo) return;
    requestPromptAction({ agentId: libraryId, action, prompt: contextMenu.prompt, returnFocusTo });
  };

  return (
    <>
      {!promptLibraryAgentId ? (
        <PromptLibraryMenu agentId={localLibraryId} projectDir={projectDir} hideTrigger />
      ) : null}
      {prompts.length > 0 ? (
        <section className="turn-empty-prompts" aria-label="Saved prompts">
          <div className="turn-empty-prompts-grid">
            {prompts.map((prompt) => (
              <Button
                key={`${prompt.scope}:${prompt.name}`}
                variant="unstyled"
                className="turn-empty-prompt-card"
                aria-label={`Insert /${prompt.name} into composer`}
                onClick={() => onInsert(prompt.content)}
                aria-haspopup="menu"
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  contextTriggerRef.current = event.currentTarget;
                  setContextMenu({ prompt, point: { x: event.clientX, y: event.clientY } });
                }}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    contextTriggerRef.current = event.currentTarget;
                    setContextMenu({ prompt, point: { x: rect.left, y: rect.bottom } });
                  }
                }}
              >
                <span className="turn-empty-prompt-card-name">/{prompt.name}</span>
                <span className="turn-empty-prompt-card-preview">{prompt.content.trim()}</span>
              </Button>
            ))}
          </div>
          {contextMenu ? (
            <PromptOptionsMenu
              triggerRef={contextTriggerRef}
              anchorPoint={contextMenu.point}
              onClose={() => setContextMenu(null)}
              onEdit={() => runPromptAction("edit")}
              onDelete={() => runPromptAction("delete")}
            />
          ) : null}
        </section>
      ) : null}
    </>
  );
}
