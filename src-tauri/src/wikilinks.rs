//! Wikilink syntax for key terms in research answers. The launch prompt asks
//! the agent to mark terms as `[[Term]]` or `[[Canonical term|text as
//! written]]`; the frontend renders those as links, and every plain-text
//! derivation on this side (response previews, recap sources) keeps only the
//! display text. Mirrors `src/lib/wikilinks.ts`; keep the two grammars in step.
//!
//! Grammar: `[[` body `]]` on one line. The body is a term, optionally followed
//! by `|` and display text. Neither part may contain `[`, `]`, `|`, or a
//! newline, and each is capped at [`MAX_WIKILINK_CHARS`] code points. A term
//! that is only whitespace is not a link. Anything that fails the grammar stays
//! literal text.

use std::borrow::Cow;

pub const MAX_WIKILINK_CHARS: usize = 160;

/// Replace every wikilink with its display text.
pub fn strip_wikilinks(text: &str) -> Cow<'_, str> {
    if !text.contains("[[") {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("[[") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        match wikilink_label(after) {
            Some((body_len, label)) => {
                out.push_str(label);
                rest = &after[body_len + 2..];
            }
            None => {
                // Advance one bracket, not two: `[[[Term]]` is a literal `[`
                // followed by a link, exactly as the frontend regex reads it.
                out.push('[');
                rest = &rest[open + 1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// Canonical terms of every wikilink in `text`, in order of first appearance
/// and without duplicates. Malformed links contribute nothing.
pub fn wikilink_terms(text: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        match wikilink_parts(after) {
            Some((body_len, term, _)) => {
                if !terms.iter().any(|known| known == term) {
                    terms.push(term.to_string());
                }
                rest = &after[body_len + 2..];
            }
            None => rest = &rest[open + 1..],
        }
    }
    terms
}

fn part_is_valid(part: &str) -> bool {
    !part.is_empty()
        && !part.contains(['[', ']', '|', '\n'])
        && part.chars().count() <= MAX_WIKILINK_CHARS
}

/// For text following a `[[` opener: the body length and display label of the
/// link it starts, or `None` when the opener is literal.
fn wikilink_label(after: &str) -> Option<(usize, &str)> {
    wikilink_parts(after).map(|(body_len, _, label)| (body_len, label))
}

/// For text following a `[[` opener: the body length, canonical term, and
/// display label of the link it starts, or `None` when the opener is literal.
fn wikilink_parts(after: &str) -> Option<(usize, &str, &str)> {
    let close = after.find("]]")?;
    let body = &after[..close];
    let (term, alias) = match body.split_once('|') {
        Some((term, alias)) => (term, Some(alias)),
        None => (body, None),
    };
    if !part_is_valid(term) || alias.is_some_and(|alias| !part_is_valid(alias)) {
        return None;
    }
    let term = term.trim();
    if term.is_empty() {
        return None;
    }
    let label = alias
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
        .unwrap_or(term);
    Some((close, term, label))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_borrowed_unchanged() {
        assert!(matches!(strip_wikilinks("no links here"), Cow::Borrowed(_)));
        assert_eq!(strip_wikilinks("a [single] bracket"), "a [single] bracket");
    }

    #[test]
    fn links_collapse_to_their_display_text() {
        assert_eq!(
            strip_wikilinks("Use [[Rust]] and [[Tokio|tokio's]] runtime."),
            "Use Rust and tokio's runtime."
        );
        assert_eq!(strip_wikilinks("[[ spaced term ]]"), "spaced term");
        assert_eq!(strip_wikilinks("[[Term| ]]"), "Term");
    }

    #[test]
    fn malformed_links_stay_literal() {
        assert_eq!(strip_wikilinks("[[]]"), "[[]]");
        assert_eq!(strip_wikilinks("[[ ]]"), "[[ ]]");
        assert_eq!(strip_wikilinks("[[unclosed"), "[[unclosed");
        assert_eq!(strip_wikilinks("[[two|pipes|here]]"), "[[two|pipes|here]]");
        assert_eq!(strip_wikilinks("[[multi\nline]]"), "[[multi\nline]]");
        assert_eq!(strip_wikilinks("[[a]b]]"), "[[a]b]]");
        let long = "x".repeat(MAX_WIKILINK_CHARS + 1);
        assert_eq!(
            strip_wikilinks(&format!("[[{long}]]")),
            format!("[[{long}]]")
        );
    }

    #[test]
    fn extra_opening_brackets_are_literal_prefixes() {
        assert_eq!(strip_wikilinks("[[[Term]]"), "[Term");
        assert_eq!(strip_wikilinks("[[[[Term]]"), "[[Term");
    }

    #[test]
    fn terms_are_collected_once_in_order() {
        assert_eq!(
            wikilink_terms("[[Rust]] and [[Tokio|tokio's]] then [[Rust]] again, [[bad|x|y]]"),
            vec!["Rust".to_string(), "Tokio".to_string()]
        );
        assert!(wikilink_terms("no links").is_empty());
    }

    #[test]
    fn a_preview_cut_mid_link_keeps_the_raw_text() {
        assert_eq!(strip_wikilinks("see [[Ru"), "see [[Ru");
    }
}
