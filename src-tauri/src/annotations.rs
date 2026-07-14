//! Transcript message annotations: a user-authored comment anchored to a text
//! span inside a single rendered transcript message. This is the durable data
//! model behind the "non-linear chat" annotation surface; the anchoring scheme
//! mirrors research highlights (an exact quote plus nearby context so a span can
//! be relocated when the rendered projection shifts) but adds the comment field
//! research highlights deliberately lack.
//!
//! Annotations are keyed by the frontend's stable timeline item key (one rendered
//! message card == one key), which survives transcript re-parses and per-agent
//! truncation, so an annotation stays attached to its message across streaming
//! updates and restarts.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Per-message annotation cap. A single message rarely wants more than a handful;
/// the cap is a runaway backstop, not a target.
pub const MAX_TRANSCRIPT_ANNOTATIONS_PER_MESSAGE: usize = 200;
pub const MAX_TRANSCRIPT_ANNOTATION_BYTES_PER_MESSAGE: usize = 256 * 1024;
pub const MAX_TRANSCRIPT_ANNOTATION_BYTES_TOTAL: usize = 4 * 1024 * 1024;
pub const MAX_TRANSCRIPT_ANNOTATION_COMMENT_BYTES: usize = 8 * 1024;
/// A selection can legitimately cover a whole long message, but the stored quote
/// should not by itself be able to blow the per-message byte cap.
pub const MAX_TRANSCRIPT_ANNOTATION_EXACT_BYTES: usize = 64 * 1024;
pub const TRANSCRIPT_ANNOTATION_CONTEXT_BYTES: usize = 512;
/// Upper bound for an anchor offset. Message projections are bounded by the
/// transcript block sizes the tail admits; this rejects absurd offsets without
/// coupling to a specific block limit.
pub const MAX_TRANSCRIPT_ANNOTATION_OFFSET: usize = 16 * 1024 * 1024;

/// The current anchor projection tag. Bumped if the way the frontend flattens a
/// message into offsets ever changes, so stale anchors self-invalidate.
pub const TRANSCRIPT_ANNOTATION_PROJECTION: &str = "transcript-v1";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAnnotation {
    pub id: String,
    /// The agent whose transcript this annotation belongs to. Kept on the record
    /// so the flat list is self-contained and so "send annotations" / cleanup can
    /// scope by agent without re-deriving it from the key.
    pub agent_id: String,
    /// The frontend timeline item key identifying the annotated message.
    pub message_key: String,
    pub anchor: MessageAnnotationAnchor,
    pub comment: String,
    pub created_at: u128,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAnnotationAnchor {
    pub version: u32,
    pub projection: String,
    /// UTF-16 offsets into the message's flat text projection (JS string units),
    /// matching how the webview computes selection offsets.
    pub start: usize,
    pub end: usize,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

pub fn validate_annotation_anchor(anchor: &MessageAnnotationAnchor) -> Result<(), String> {
    if anchor.version != 1 || anchor.projection != TRANSCRIPT_ANNOTATION_PROJECTION {
        return Err("unsupported transcript annotation anchor".to_string());
    }
    if anchor.start >= anchor.end || anchor.exact.trim().is_empty() {
        return Err("annotation selection cannot be empty".to_string());
    }
    // start/end are UTF-16 code-unit offsets, so the span width must equal the
    // exact quote's UTF-16 length. This is the same coupling research highlights
    // enforce and it catches offsets computed against a different projection.
    if anchor.end > MAX_TRANSCRIPT_ANNOTATION_OFFSET
        || anchor.end - anchor.start != anchor.exact.encode_utf16().count()
    {
        return Err("annotation has invalid selection offsets".to_string());
    }
    if anchor.exact.len() > MAX_TRANSCRIPT_ANNOTATION_EXACT_BYTES
        || anchor.prefix.len() > TRANSCRIPT_ANNOTATION_CONTEXT_BYTES
        || anchor.suffix.len() > TRANSCRIPT_ANNOTATION_CONTEXT_BYTES
    {
        return Err("annotation selection is too large".to_string());
    }
    Ok(())
}

pub fn validate_annotation_comment(comment: &str) -> Result<(), String> {
    if comment.trim().is_empty() {
        return Err("annotation comment cannot be empty".to_string());
    }
    if comment.len() > MAX_TRANSCRIPT_ANNOTATION_COMMENT_BYTES {
        return Err("annotation comment is too long".to_string());
    }
    Ok(())
}

pub fn annotation_storage_bytes(annotation: &MessageAnnotation) -> usize {
    // A conservative allowance for JSON field names, punctuation, numeric offsets,
    // and worst-case escaping (a control char expands to a six-byte JSON escape),
    // so the cap stays authoritative without serializing the whole model.
    200usize
        .saturating_add(annotation.id.len())
        .saturating_add(annotation.agent_id.len())
        .saturating_add(annotation.message_key.len())
        .saturating_add(annotation.anchor.projection.len())
        .saturating_add(annotation.comment.len().saturating_mul(6))
        .saturating_add(annotation.anchor.exact.len().saturating_mul(6))
        .saturating_add(annotation.anchor.prefix.len().saturating_mul(6))
        .saturating_add(annotation.anchor.suffix.len().saturating_mul(6))
}

pub fn annotation_collection_storage_bytes(annotations: &[MessageAnnotation]) -> usize {
    annotations.iter().fold(0usize, |total, annotation| {
        total.saturating_add(annotation_storage_bytes(annotation))
    })
}

pub fn validate_annotation_collection(annotations: &[MessageAnnotation]) -> Result<(), String> {
    if annotations.len() > MAX_TRANSCRIPT_ANNOTATIONS_PER_MESSAGE {
        return Err(format!(
            "a message can have at most {MAX_TRANSCRIPT_ANNOTATIONS_PER_MESSAGE} annotations"
        ));
    }
    let mut ids = HashSet::new();
    for annotation in annotations {
        if annotation.id.is_empty() || !ids.insert(annotation.id.as_str()) {
            return Err("annotations must have unique non-empty ids".to_string());
        }
        validate_annotation_anchor(&annotation.anchor)?;
        validate_annotation_comment(&annotation.comment)?;
    }
    if annotation_collection_storage_bytes(annotations)
        > MAX_TRANSCRIPT_ANNOTATION_BYTES_PER_MESSAGE
    {
        return Err("a message contains too much annotation data".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(exact: &str) -> MessageAnnotationAnchor {
        MessageAnnotationAnchor {
            version: 1,
            projection: TRANSCRIPT_ANNOTATION_PROJECTION.to_string(),
            start: 0,
            end: exact.encode_utf16().count(),
            exact: exact.to_string(),
            prefix: String::new(),
            suffix: String::new(),
        }
    }

    fn annotation(id: &str, exact: &str, comment: &str) -> MessageAnnotation {
        MessageAnnotation {
            id: id.to_string(),
            agent_id: "agent-1".to_string(),
            message_key: "message-assistant-agent-1-3:0".to_string(),
            anchor: anchor(exact),
            comment: comment.to_string(),
            created_at: 1,
        }
    }

    #[test]
    fn accepts_a_well_formed_anchor() {
        assert!(validate_annotation_anchor(&anchor("hello world")).is_ok());
    }

    #[test]
    fn rejects_wrong_projection_or_version() {
        let mut bad = anchor("hi");
        bad.projection = "answer-v1".to_string();
        assert!(validate_annotation_anchor(&bad).is_err());
        let mut bad = anchor("hi");
        bad.version = 2;
        assert!(validate_annotation_anchor(&bad).is_err());
    }

    #[test]
    fn rejects_offsets_that_disagree_with_the_quote() {
        let mut bad = anchor("hello");
        bad.end = bad.start + 2; // width no longer matches the UTF-16 length of "hello"
        assert!(validate_annotation_anchor(&bad).is_err());
    }

    #[test]
    fn offset_width_counts_utf16_code_units() {
        // An astral emoji is two UTF-16 code units; the anchor helper encodes that.
        let a = anchor("😀");
        assert_eq!(a.end - a.start, 2);
        assert!(validate_annotation_anchor(&a).is_ok());
    }

    #[test]
    fn rejects_empty_or_whitespace_quote() {
        let mut bad = anchor("   ");
        bad.end = bad.start + 3;
        assert!(validate_annotation_anchor(&bad).is_err());
    }

    #[test]
    fn rejects_empty_and_oversized_comments() {
        assert!(validate_annotation_comment("   ").is_err());
        assert!(validate_annotation_comment("looks good").is_ok());
        let huge = "x".repeat(MAX_TRANSCRIPT_ANNOTATION_COMMENT_BYTES + 1);
        assert!(validate_annotation_comment(&huge).is_err());
    }

    #[test]
    fn rejects_duplicate_ids_in_a_collection() {
        let list = vec![
            annotation("a", "hello", "one"),
            annotation("a", "world", "two"),
        ];
        assert!(validate_annotation_collection(&list).is_err());
    }

    #[test]
    fn accepts_a_valid_collection() {
        let list = vec![
            annotation("a", "hello", "one"),
            annotation("b", "world", "two"),
        ];
        assert!(validate_annotation_collection(&list).is_ok());
    }
}
