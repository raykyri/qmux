import { taggedUserInstructionDetails } from "./taggedInstructions";

/** Recognize complete injected messages, never tag examples embedded in prose. */
export function transcriptDisclosureLabel(text: string, role: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\n") ||
      trimmed.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]\r\n")) {
    return taskNotificationLabel(trimmed) ?? "System notification";
  }
  if (/^#{1,2} Environment update\r?\n/.test(trimmed)) {
    return "Environment update";
  }
  const skill = /^Base directory for this skill:[ \t]*([^\r\n]+)(?:\r?\n|$)/.exec(trimmed);
  if (skill) {
    const name = skill[1].trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    return name ? `Skill: ${name}` : "Skill instructions";
  }

  // Only user-role messages get the broad tagged-instruction treatment.
  // Assistant answers can legitimately contain standalone XML examples.
  const tagged = taggedUserInstructionDetails(trimmed);
  if (tagged?.tags.length === 1) {
    switch (tagged.tags[0]) {
      case "task-notification":
        return taskNotificationLabel(trimmed);
      case "environment_context":
      case "environment_details":
        return "Environment context";
      case "environment_update":
        return "Environment update";
      case "skill":
      case "skills":
      case "skill_instructions":
        return "Skill instructions";
    }
  }
  return role === "user" ? tagged?.label ?? null : null;
}

function taskNotificationLabel(text: string): string | null {
  if (!text.includes("<task-notification>")) return null;
  const status = /<status>\s*(completed|failed|running|stopped)\s*<\/status>/.exec(text)?.[1];
  return status ? `Background task ${status}` : "Background task notification";
}
