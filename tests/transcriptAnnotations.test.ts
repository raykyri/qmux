import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotationMessage,
  groupAnnotationsByMessage,
  resolveAnnotationOffset,
} from "../src/lib/transcriptAnnotations";
import type { MessageAnnotation, MessageAnnotationAnchor } from "../src/types";

function anchor(
  projection: string,
  start: number,
  end: number,
  overrides: Partial<MessageAnnotationAnchor> = {},
): MessageAnnotationAnchor {
  return {
    version: 1,
    projection: "transcript-v1",
    start,
    end,
    exact: projection.slice(start, end),
    prefix: projection.slice(Math.max(0, start - 8), start),
    suffix: projection.slice(end, end + 8),
    ...overrides,
  };
}

test("resolves an anchor at its stored offsets", () => {
  const projection = "the quick brown fox";
  const a = anchor(projection, 4, 9); // "quick"
  assert.deepEqual(resolveAnnotationOffset(projection, a), { start: 4, end: 9 });
});

test("relocates when the message gained a prefix", () => {
  const original = "the quick brown fox";
  const a = anchor(original, 4, 9); // "quick", prefix "the "
  const shifted = "well, the quick brown fox";
  const resolved = resolveAnnotationOffset(shifted, a);
  assert.ok(resolved);
  assert.equal(shifted.slice(resolved.start, resolved.end), "quick");
});

test("context guards against painting an unrelated identical quote", () => {
  // "fox" appears twice; the anchor targets the second, whose immediate context
  // ("the sly " before it) is preserved after the edit, while the first
  // occurrence's context changes. Only the correctly-contexted one may resolve.
  const original = "the wild fox and the sly fox jumps";
  const a = anchor(original, 25, 28); // second "fox"
  assert.equal(original.slice(a.start, a.end), "fox");
  assert.equal(a.prefix, "the sly ");
  const changed = "a lone fox and the sly fox jumps"; // first clause reworded
  const resolved = resolveAnnotationOffset(changed, a);
  assert.ok(resolved);
  assert.equal(changed.slice(resolved.start, resolved.end), "fox");
  assert.equal(changed.slice(resolved.start - 8, resolved.start), "the sly ");
});

test("returns null when the quote is gone", () => {
  const a = anchor("hello world", 0, 5); // "hello"
  assert.equal(resolveAnnotationOffset("nothing similar here", a), null);
});

test("handles astral characters by UTF-16 units", () => {
  const projection = "wave 👋 hello";
  // "👋" is two UTF-16 code units; the emoji spans indices 5..7.
  const a = anchor(projection, 5, 7);
  assert.equal(a.exact, "👋");
  assert.deepEqual(resolveAnnotationOffset(projection, a), { start: 5, end: 7 });
});

function annotation(exact: string, comment: string): MessageAnnotation {
  return {
    id: `annotation-${exact}`,
    agentId: "agent-1",
    messageKey: "message-assistant-agent-1-3:0",
    anchor: anchor(exact, 0, exact.length),
    comment,
    createdAt: 1,
  };
}

test("groups annotations by message key preserving order", () => {
  const list: MessageAnnotation[] = [
    { ...annotation("a", "one"), messageKey: "m1" },
    { ...annotation("b", "two"), messageKey: "m2" },
    { ...annotation("c", "three"), messageKey: "m1" },
  ];
  const grouped = groupAnnotationsByMessage(list);
  assert.deepEqual(
    grouped.get("m1")?.map((a) => a.comment),
    ["one", "three"],
  );
  assert.deepEqual(
    grouped.get("m2")?.map((a) => a.comment),
    ["two"],
  );
});

test("builds a single-note follow-up message", () => {
  const message = buildAnnotationMessage([annotation("the plan step", "reconsider this")]);
  assert.equal(
    message,
    "A note on your response:\n\n> the plan step\nreconsider this",
  );
});

test("builds a multi-note follow-up with quotes and comments", () => {
  const message = buildAnnotationMessage([
    annotation("first", "fix a"),
    annotation("second", "fix b"),
  ]);
  assert.equal(
    message,
    "2 notes on your response:\n\n> first\nfix a\n\n> second\nfix b",
  );
});

test("multi-line quotes are prefixed per line", () => {
  const message = buildAnnotationMessage([annotation("line one\nline two", "note")]);
  assert.equal(message, "A note on your response:\n\n> line one\n> line two\nnote");
});

test("empty annotation list yields an empty string", () => {
  assert.equal(buildAnnotationMessage([]), "");
});
