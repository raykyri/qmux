import { useEffect, useState } from "react";
import { listSavedPrompts } from "../lib/api";
import { listenToPromptLibraryChanged } from "../lib/promptLibrary";
import type { SavedPrompt } from "../types";
import { Button } from "./ui";

interface EmptyPromptCardsProps {
  projectDir: string | null;
  onInsert: (text: string) => void;
}

export default function EmptyPromptCards({ projectDir, onInsert }: EmptyPromptCardsProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);

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

  if (prompts.length === 0) return null;

  return (
    <section className="turn-empty-prompts" aria-label="Saved prompts">
      <div className="turn-empty-prompts-grid">
        {prompts.map((prompt) => (
          <Button
            key={`${prompt.scope}:${prompt.name}`}
            variant="unstyled"
            className="turn-empty-prompt-card"
            aria-label={`Insert /${prompt.name} into composer`}
            onClick={() => onInsert(prompt.content)}
          >
            <span className="turn-empty-prompt-card-name">/{prompt.name}</span>
            <span className="turn-empty-prompt-card-preview">{prompt.content.trim()}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}
