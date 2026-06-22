// qmux integration plugin for opencode.
//
// Runs inside an opencode agent launched by qmux and does two things:
//   1. Forwards lifecycle events to `qmux notify <event>` over the qmux Unix
//      socket, so qmux can track agent status (running, idle, awaiting
//      permission) exactly like its Claude and Codex adapters.
//   2. Appends one JSON line per message part to a qmux-managed JSONL file at
//      $QMUX_WORKSPACE_ROOT/.qmux/opencode/$QMUX_AGENT_ID.jsonl, shaped for
//      OpenCodeAdapter::parse_transcript_line. qmux tails this file with the
//      same transcript pipeline it uses for Claude and Codex.
//
// No-ops outside qmux (when the QMUX_* env vars are absent), so the same
// opencode config dir can be used by standalone opencode sessions.

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const SOCK = process.env.QMUX_SOCK;
const TOKEN = process.env.QMUX_TOKEN;
const PANE_ID = process.env.QMUX_PANE_ID;
const AGENT_ID = process.env.QMUX_AGENT_ID;
const CLI = process.env.QMUX_CLI;
const WORKSPACE_ROOT = process.env.QMUX_WORKSPACE_ROOT;

const IN_QMUX = SOCK && TOKEN && PANE_ID && AGENT_ID && CLI;

// Notify qmux of a lifecycle event. Best-effort: any failure is swallowed so
// the agent never blocks on qmux.
async function notify(event, payload) {
  if (!IN_QMUX) return;
  try {
    const args = ["notify", event];
    const env = {
      ...process.env,
      QMUX_SOCK: SOCK,
      QMUX_TOKEN: TOKEN,
      QMUX_PANE_ID: PANE_ID,
      QMUX_AGENT_ID: AGENT_ID,
    };
    if (payload && Object.keys(payload).length) {
      args.push(JSON.stringify(payload));
    }
    await new Promise((resolve) => {
      const child = spawn(CLI, args, {
        env,
        stdio: "ignore",
      });
      child.on("error", resolve);
      child.on("close", resolve);
    });
  } catch {
    // Swallow: qmux is best-effort and must never break the agent.
  }
}

// Append a transcript line. The shape matches what
// OpenCodeAdapter::parse_transcript_line expects.
async function writeTranscriptItem(sessionId, payload) {
  if (!IN_QMUX || !WORKSPACE_ROOT) return;
  try {
    const dir = join(WORKSPACE_ROOT, ".qmux", "opencode");
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      type: "response_item",
      payload,
      session_id: sessionId,
    });
    await appendFile(join(dir, `${AGENT_ID}.jsonl`), `${line}\n`, "utf8");
  } catch {
    // Swallow: transcript tailing is best-effort.
  }
}

async function writeTranscriptMessage(sessionId, role, content) {
  await writeTranscriptItem(sessionId, { type: "message", role, content });
}

// Map opencode content parts to the shape OpenCodeAdapter::parse_transcript_line
// understands (same as Codex: {type:"text",text} | {type:"tool_use",...} | ...).
function normalizePart(part) {
  if (!part || typeof part !== "object") return null;
  // opencode text parts.
  if (part.type === "text") return { type: "text", text: part.text ?? "" };
  // Tool calls.
  if (part.type === "tool_use")
    return {
      type: "tool_use",
      id: part.id ?? null,
      name: part.name ?? "tool",
      input: part.input ?? null,
    };
  // Tool results.
  if (part.type === "tool_result")
    return {
      type: "tool_result",
      tool_use_id: part.tool_use_id ?? null,
      content: part.content ?? null,
      is_error: Boolean(part.is_error),
    };
  // Pass through anything else as a raw block.
  return { type: "raw", value: part };
}

function normalizeToolResultPart(part) {
  const state = part.state ?? {};
  return {
    type: "tool_result",
    tool_use_id: part.callID ?? part.id ?? null,
    content: state.output ?? state.error ?? null,
    is_error: state.status === "error",
  };
}

function normalizeContent(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.map(normalizePart).filter(Boolean);
}

function promptTextFromContent(content) {
  return content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sessionIdFrom(value) {
  return (
    value?.sessionID ??
    value?.sessionId ??
    value?.session_id ??
    value?.info?.id ??
    value?.info?.sessionID ??
    value?.info?.sessionId ??
    null
  );
}

export const QmuxNotifyPlugin = async () => {
  if (!IN_QMUX) return {};

  let lastSessionId = null;
  const messageRoles = new Map();
  const writtenToolUses = new Set();
  const writtenToolResults = new Set();
  const idleNotifiedAt = new Map();

  async function notifyIdle(sessionId) {
    const key = sessionId ?? "__unknown__";
    const now = Date.now();
    const previous = idleNotifiedAt.get(key) ?? 0;
    if (now - previous < 1000) return;
    idleNotifiedAt.set(key, now);
    await notify("Stop", { session_id: sessionId });
  }

  async function handleEvent(input) {
    const event = input?.event;
    const type = event?.type;
    const properties = event?.properties ?? {};
    const sid = sessionIdFrom(properties) ?? lastSessionId;

    if (type === "session.created") {
      lastSessionId = sid;
      await notify("SessionStart", { session_id: sid });
      return;
    }

    if (type === "session.idle") {
      await notifyIdle(sid);
      return;
    }

    if (type === "session.status") {
      const status = properties?.status?.type ?? properties?.info?.status ?? null;
      if (status === "idle") {
        await notifyIdle(sid);
      }
      return;
    }

    if (type === "message.updated") {
      const info = properties.info;
      if (info?.id && info?.role) {
        messageRoles.set(info.id, info.role);
      }
      return;
    }

    if (type === "message.part.updated") {
      const part = properties.part;
      if (!part) return;
      const partSessionId = part.sessionID ?? properties.sessionID ?? sid;
      const role = messageRoles.get(part.messageID) ?? "assistant";

      if (role === "user") return;

      if (part.type === "text") {
        if (!part.time?.end) return;
        const content = normalizeContent([part]);
        if (content.length) {
          await writeTranscriptMessage(partSessionId, role, content);
        }
        return;
      }

      if (part.type === "tool") {
        const callID = part.callID ?? part.id;
        if (!callID) return;
        if (!writtenToolUses.has(callID) && part.state?.input) {
          writtenToolUses.add(callID);
          await writeTranscriptItem(partSessionId, {
            type: "tool_use",
            name: part.tool ?? "tool",
            id: callID,
            input: part.state.input,
          });
        }
        if (
          !writtenToolResults.has(callID) &&
          (part.state?.status === "completed" || part.state?.status === "error")
        ) {
          writtenToolResults.add(callID);
          await writeTranscriptItem(partSessionId, normalizeToolResultPart(part));
        }
      }
    }
  }

  return {
    // Lifecycle and message-part updates are delivered through OpenCode's
    // catch-all event hook.
    event: handleEvent,

    // Permission: a tool needs approval.
    "permission.ask": async (input) => {
      await notify("PermissionRequest", {
        session_id: input?.sessionID ?? lastSessionId,
      });
    },

    // User prompts: use the dedicated chat hook so qmux can match the actual
    // prompt text against outstanding direct/queued sends.
    "chat.message": async (input, output) => {
      const sid = input?.sessionID ?? lastSessionId;
      lastSessionId = sid;
      const content = normalizeContent(output?.parts ?? []);
      const prompt = promptTextFromContent(content);
      await notify("UserPromptSubmit", {
        session_id: sid,
        ...(prompt ? { prompt } : {}),
      });
      if (content.length) {
        const role = output?.message?.role ?? "user";
        if (output?.message?.id) {
          messageRoles.set(output.message.id, role);
        }
        await writeTranscriptMessage(sid, role, content);
      }
    },

    // Tool events: forward lifecycle notifications and write exact tool payloads.
    "tool.execute.before": async (input, output) => {
      const sid = input?.sessionID ?? lastSessionId;
      await notify("PreToolUse", { session_id: sid });
      const callID = input?.callID;
      if (callID && !writtenToolUses.has(callID)) {
        writtenToolUses.add(callID);
        await writeTranscriptItem(sid, {
          type: "tool_use",
          name: input?.tool ?? "tool",
          id: callID,
          input: output?.args ?? null,
        });
      }
    },
    "tool.execute.after": async (input, output) => {
      const sid = input?.sessionID ?? lastSessionId;
      await notify("PostToolUse", { session_id: sid });
      const callID = input?.callID;
      if (callID && !writtenToolResults.has(callID)) {
        writtenToolResults.add(callID);
        await writeTranscriptItem(sid, {
          type: "tool_result",
          tool_use_id: callID,
          content: output?.output ?? null,
          is_error: false,
        });
      }
    },
  };
};
