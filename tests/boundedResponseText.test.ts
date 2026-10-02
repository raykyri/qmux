import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedResponseText } from "../web/responseText";

const tooLarge = () => new Error("response exceeded byte limit");

test("declared oversized bodies are cancelled before any read", async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reads += 1;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const expected = new Error("caller-specific failure");
  const response = new Response(body, { headers: { "Content-Length": "5" } });
  await assert.rejects(
    readBoundedResponseText(response, 4, () => expected),
    (error) => error === expected,
  );
  assert.equal(reads, 0);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

for (const declaredLength of [undefined, "1"]) {
  test(`streamed byte limits reject overflow with ${declaredLength ? "understated" : "missing"} Content-Length`, async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1;
          controller.enqueue(new TextEncoder().encode("é"));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, {
      headers: declaredLength ? { "Content-Length": declaredLength } : {},
    });
    await assert.rejects(
      readBoundedResponseText(response, 3, tooLarge),
      /exceeded byte limit/,
    );
    assert.equal(reads, 2);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });
}

test("exact byte limits accept split UTF-8 sequences without corrupting text", async () => {
  const bytes = new TextEncoder().encode("A界🙂");
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
  assert.equal(
    await readBoundedResponseText(new Response(body), bytes.length, tooLarge),
    "A界🙂",
  );
  assert.equal(body.locked, false);
});

test("bodyless responses return empty text", async () => {
  assert.equal(
    await readBoundedResponseText(
      new Response(null, { status: 204 }),
      0,
      tooLarge,
    ),
    "",
  );
});

test("read failures retain the upstream error and release the reader", async () => {
  const expected = new Error("upstream disconnected");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(expected);
    },
  });
  await assert.rejects(
    readBoundedResponseText(new Response(body), 100, tooLarge),
    (error) => error === expected,
  );
  assert.equal(body.locked, false);
});
