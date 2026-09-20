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

/// An open fenced code block: the fence character and how many of them opened
/// it. A closing run must use the same character and be at least as long.
struct MarkdownFence {
    marker: u8,
    length: usize,
}

fn leading_spaces(line: &str) -> usize {
    line.bytes().take_while(|byte| *byte == b' ').count()
}

/// The code fence this line opens, or `None` when it opens none. Mirrors
/// `markerRunAtLineStart` in `src/lib/markdownMathDelimiters.ts`.
fn marker_run_at_line_start(line: &str) -> Option<MarkdownFence> {
    let indent = leading_spaces(line);
    if indent > 3 {
        return None;
    }
    let rest = &line.as_bytes()[indent..];
    let marker = *rest.first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let length = rest.iter().take_while(|byte| **byte == marker).count();
    (length >= 3).then_some(MarkdownFence { marker, length })
}

/// Whether this line closes `fence`. Mirrors `closesFence` in
/// `src/lib/markdownMathDelimiters.ts`.
fn closes_fence(line: &str, fence: &MarkdownFence) -> bool {
    let indent = leading_spaces(line).min(3);
    let rest = &line.as_bytes()[indent..];
    let run = rest
        .iter()
        .take_while(|byte| **byte == fence.marker)
        .count();
    run >= fence.length
        && rest[run..]
            .iter()
            .all(|byte| matches!(byte, b'\t' | b' ' | b'\r'))
}

fn backtick_run_length(line: &[u8], start: usize) -> usize {
    line[start..]
        .iter()
        .take_while(|byte| **byte == b'`')
        .count()
}

/// Index just past the next backtick run of exactly `length`, or `None` when
/// the opener is unmatched and its backticks are literal text.
fn matching_backtick_run_end(line: &[u8], start: usize, length: usize) -> Option<usize> {
    let mut cursor = start;
    while cursor < line.len() {
        let candidate = cursor + line[cursor..].iter().position(|byte| *byte == b'`')?;
        let candidate_length = backtick_run_length(line, candidate);
        if candidate_length == length {
            return Some(candidate + length);
        }
        cursor = candidate + candidate_length;
    }
    None
}

/// Walk `text` as Markdown, handing every stretch to `visit` together with
/// whether it is prose. Non-prose stretches are fenced code blocks, indented
/// code lines, code spans, and the newlines between lines; `visit` sees the
/// whole input exactly once, in order, so a caller can rebuild it verbatim.
fn visit_markdown_segments(text: &str, visit: &mut impl FnMut(&str, bool)) {
    let mut fence: Option<MarkdownFence> = None;
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            visit("\n", false);
        }
        if let Some(active) = &fence {
            if closes_fence(line, active) {
                fence = None;
            }
            visit(line, false);
            continue;
        }
        if let Some(opening) = marker_run_at_line_start(line) {
            fence = Some(opening);
            visit(line, false);
            continue;
        }
        if line.starts_with("    ") || line.starts_with('\t') {
            visit(line, false);
            continue;
        }
        visit_code_spans(line, visit);
    }
}

/// Split one line into its code spans and the prose around them. An unmatched
/// backtick run is literal text, so it stays with the prose that follows it.
fn visit_code_spans(line: &str, visit: &mut impl FnMut(&str, bool)) {
    let bytes = line.as_bytes();
    let mut prose_start = 0;
    let mut cursor = 0;
    while cursor < line.len() {
        let Some(offset) = line[cursor..].find('`') else {
            break;
        };
        let tick = cursor + offset;
        let run = backtick_run_length(bytes, tick);
        match matching_backtick_run_end(bytes, tick + run, run) {
            Some(end) => {
                visit(&line[prose_start..tick], true);
                visit(&line[tick..end], false);
                prose_start = end;
                cursor = end;
            }
            None => cursor = tick + run,
        }
    }
    visit(&line[prose_start..], true);
}

/// Replace the wikilinks in one stretch of prose — no fences, no code spans.
fn strip_prose_into(segment: &str, out: &mut String) {
    let mut rest = segment;
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
}

/// Replace every wikilink with its display text, skipping fenced code blocks,
/// indented code lines, and code spans. The frontend's markdown transform skips
/// `code` and `inlineCode` nodes, so the plain-text derivations must skip them
/// too: these helpers also run over terminal agent transcripts (pane exports,
/// conversation previews), where `if [[ -f x ]]` and Lua `t[[str]]` would
/// otherwise lose their brackets. Mirrors `stripWikilinks` in
/// `src/lib/wikilinks.ts`.
pub fn strip_wikilinks(text: &str) -> Cow<'_, str> {
    if !text.contains("[[") {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    visit_markdown_segments(text, &mut |segment, is_prose| {
        if is_prose {
            strip_prose_into(segment, &mut out);
        } else {
            out.push_str(segment);
        }
    });
    if out == text {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(out)
    }
}

/// Canonical terms of every wikilink in `text`, in order of first appearance
/// and without duplicates. Malformed links contribute nothing, and code — fenced
/// blocks, indented lines and code spans — contributes nothing either, matching
/// what the renderer turns into links.
pub fn wikilink_terms(text: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    visit_markdown_segments(text, &mut |segment, is_prose| {
        if !is_prose {
            return;
        }
        let mut rest = segment;
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
    });
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
    fn fenced_code_keeps_its_bracket_syntax() {
        let source = "Check it:\n\n```bash\nif [[ -f x ]]; then echo hi; fi\n```\n\nDone.";
        assert_eq!(strip_wikilinks(source), source);
        assert!(matches!(strip_wikilinks(source), Cow::Borrowed(_)));
        let tildes = "~~~\nif [[ -n \"$VAR\" ]]; then :; fi\n~~~";
        assert_eq!(strip_wikilinks(tildes), tildes);
        let indented = "text\n\n    if [[ -d dir ]]; then :; fi\n";
        assert_eq!(strip_wikilinks(indented), indented);
    }

    #[test]
    fn code_spans_keep_their_bracket_syntax() {
        assert_eq!(
            strip_wikilinks("Use `[[ -n \"$VAR\" ]]` to test."),
            "Use `[[ -n \"$VAR\" ]]` to test."
        );
        assert_eq!(
            strip_wikilinks("Lua ``t[[str]]`` and arr `[[1]]`."),
            "Lua ``t[[str]]`` and arr `[[1]]`."
        );
        // An unmatched run is literal text, so prose around it still strips.
        assert_eq!(
            strip_wikilinks("a ` stray tick and [[Term]]"),
            "a ` stray tick and Term"
        );
    }

    #[test]
    fn links_outside_code_still_strip_alongside_code() {
        assert_eq!(
            strip_wikilinks("See [[Rust]].\n\n```bash\n[[ -f x ]]\n```\n\nAnd [[Tokio|tokio]]."),
            "See Rust.\n\n```bash\n[[ -f x ]]\n```\n\nAnd tokio."
        );
        assert_eq!(
            strip_wikilinks("[[Rust]] uses `[[Term]]` then [[Tokio]]"),
            "Rust uses `[[Term]]` then Tokio"
        );
    }

    #[test]
    fn an_unclosed_fence_swallows_the_rest_of_the_text() {
        let source = "before [[Rust]]\n```\n[[ -f x ]]\nstill code [[Term]]";
        assert_eq!(
            strip_wikilinks(source),
            "before Rust\n```\n[[ -f x ]]\nstill code [[Term]]"
        );
    }

    #[test]
    fn terms_skip_code() {
        assert_eq!(
            wikilink_terms("[[Rust]]\n\n```bash\n[[ -f x ]]\n```\n\n`[[Span]]` and [[Tokio]]"),
            vec!["Rust".to_string(), "Tokio".to_string()]
        );
    }

    #[test]
    fn a_preview_cut_mid_link_keeps_the_raw_text() {
        assert_eq!(strip_wikilinks("see [[Ru"), "see [[Ru");
    }
}
