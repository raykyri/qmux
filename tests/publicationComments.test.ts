import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  encodeProposalResolution,
  encodePublicationComment,
  encodeResearchProposal,
  parseProposalResolution,
  parsePublicationComment,
  parseResearchProposal,
  researchProposalDigestInput,
} from "../src/lib/publicationComments";

test("publication comments round-trip a validated research node anchor", () => {
  const encoded = encodePublicationComment(
    {
      publicationId: "pub_comments123",
      nodeId: "node_comments123",
    },
    "A **useful** comment.",
  );
  assert.deepEqual(parsePublicationComment(encoded), {
    anchor: {
      publicationId: "pub_comments123",
      nodeId: "node_comments123",
    },
    body: "A **useful** comment.",
  });
});

test("ordinary and malformed GitHub comments remain visible as unanchored markdown", () => {
  assert.deepEqual(parsePublicationComment("Plain comment"), {
    anchor: null,
    body: "Plain comment",
  });
  const malformed = "<!-- qmux-comment:v1 {not-json} -->\n\nKeep this visible";
  assert.deepEqual(parsePublicationComment(malformed), {
    anchor: null,
    body: malformed,
  });
});

test("research proposal and owner resolution envelopes preserve Markdown payloads", () => {
  const proposal = encodeResearchProposal({
    publicationId: "pub_comments123",
    parentNodeId: "node_comments123",
    prompt: "Compare `A --> B` and **C**.",
    answerMarkdown: "A possible answer with café context.",
  });
  assert.deepEqual(parseResearchProposal(proposal), {
    publicationId: "pub_comments123",
    parentNodeId: "node_comments123",
    prompt: "Compare `A --> B` and **C**.",
    answerMarkdown: "A possible answer with café context.",
  });
  const proposalDigest = createHash("sha256")
    .update(
      researchProposalDigestInput({
        publicationId: "pub_comments123",
        parentNodeId: "node_comments123",
        prompt: "Compare `A --> B` and **C**.",
        answerMarkdown: "A possible answer with café context.",
      }),
    )
    .digest("hex");

  const resolution = encodeProposalResolution({
    publicationId: "pub_comments123",
    proposalCommentId: 42,
    proposalDigest,
    status: "accepted",
    publicNodeId: "node_published123",
  });
  assert.deepEqual(parseProposalResolution(resolution), {
    publicationId: "pub_comments123",
    proposalCommentId: 42,
    proposalDigest,
    status: "accepted",
    publicNodeId: "node_published123",
  });
});

test("anchored proposals round-trip their passage and extend the digest", () => {
  const anchor = {
    start: 120,
    end: 168,
    exact: "the first failure cancels the siblings",
    prefix: "a task group, ",
    suffix: ", which turns",
  };
  const encoded = encodeResearchProposal({
    publicationId: "pub_comments123",
    parentNodeId: "node_comments123",
    prompt: "Does this hold for Rust async?",
    anchor,
  });
  const parsed = parseResearchProposal(encoded);
  assert.deepEqual(parsed?.anchor, anchor);

  const base = {
    publicationId: "pub_comments123",
    parentNodeId: "node_comments123",
    prompt: "Does this hold for Rust async?",
  };
  // Anchor-free digests keep the original input so existing resolutions stay
  // valid; an anchor must change the digest.
  assert.equal(
    researchProposalDigestInput(base),
    JSON.stringify([
      "pub_comments123",
      "node_comments123",
      "Does this hold for Rust async?",
      null,
    ]),
  );
  assert.notEqual(
    researchProposalDigestInput({ ...base, anchor }),
    researchProposalDigestInput(base),
  );

  // Oversized or inverted anchors invalidate the whole proposal.
  assert.equal(
    parseResearchProposal(
      encoded.replace(
        encoded.slice(
          "<!-- qmux-proposal:v1 ".length,
          encoded.indexOf(" -->"),
        ),
        Buffer.from(
          JSON.stringify({
            ...base,
            anchor: { ...anchor, end: anchor.start },
          }),
        )
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, ""),
      ),
    ),
    null,
  );
});
