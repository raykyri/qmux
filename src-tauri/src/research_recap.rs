//! Optional derived metadata; generation never delays research completion.
use crate::events::QmuxEvent;
use crate::research::{self, ResearchNodeStatus};
use crate::state::AppState;
use crate::transcript::{Turn, TurnBlock};
use pulldown_cmark::{Event, Parser, TagEnd};
use serde_json::json;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

pub const MIN_RECAP_CHARS: usize = 800;
pub const MAX_RECAP_INSTRUCTIONS_CHARS: usize = 4_000;
pub const DEFAULT_RECAP_INSTRUCTIONS: &str = "Write a compact recap that directly answers the user's question using only the supplied answer. Usually use 30-70 words. For recommendations, name the recommended items and people. For analysis, preserve the main conclusion, mechanism, and essential qualifications. Short sentences and semicolon-separated phrases are fine. Do not merely describe what the answer discusses.";
// Bound automatic summary input for generated runs. Imported reports bypass
// this cutoff so their complete text reaches the summarizer.
const MAX_SOURCE_BYTES: usize = 80_000;

static JOBS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct Job(String);
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = JOBS.get_or_init(Default::default).lock() {
            jobs.remove(&self.0);
        }
    }
}

/// Whether the node's content arrived as a finished report rather than being
/// produced by a research run. Imported reports skip the length cutoff so
/// their complete text reaches the summarizer.
fn node_is_imported(node: &research::ResearchNode) -> bool {
    node.origin == Some(research::ResearchNodeOrigin::Imported)
}

pub fn schedule(state: &AppState, node_id: &str) {
    // Unit tests exercise extraction, provider calls, and stale-result handling
    // separately; lifecycle fixtures must never launch installed, paid agents.
    if cfg!(test) {
        return;
    }
    let Ok(node) = state.research_node(node_id) else {
        return;
    };
    if !node.kind.is_run()
        || node.status != ResearchNodeStatus::Complete
        || node.response_snapshot_at.is_none()
        || node.recap.is_some()
        || !matches!(node.adapter.as_str(), "claude" | "codex" | "grok")
    {
        return;
    }
    let key = format!(
        "{}:{}:{:?}",
        state.config().workspace_root.display(),
        node.id,
        node.response_snapshot_at
    );
    let Ok(mut jobs) = JOBS.get_or_init(Default::default).lock() else {
        return;
    };
    if !jobs.insert(key.clone()) {
        return;
    }
    drop(jobs);
    let state = state.clone();
    // The viewer reserves space for the summary while the job runs; the paired
    // `false` emit below fires on every exit path, including skipped sources.
    emit_pending(&state, &node.id, true);
    std::thread::spawn(move || {
        let _job = Job(key);
        let result = (|| -> Result<(), String> {
            let Some(snapshot) = research::read_response_snapshot_with_revision(
                &state.config().workspace_root,
                &node.id,
            )?
            else {
                return Ok(());
            };
            let Some(answer) = recap_source_for_node(&node, &snapshot.turns) else {
                return Ok(());
            };
            if !node_is_imported(&node) && answer.len() + node.prompt.len() > MAX_SOURCE_BYTES {
                return Ok(());
            }
            let workspace = state.research_workspace_for_node(&node.id)?;
            let text = crate::title_generation::generate_research_recap(
                state.config(),
                &node,
                &workspace,
                &answer,
            )?;
            state.save_research_recap(&node, &snapshot.revision, text)
        })();
        if let Err(err) = result {
            eprintln!("qmux: recap generation failed for {}: {err}", node.id);
        }
        emit_pending(&state, &node.id, false);
    });
}

fn emit_pending(state: &AppState, node_id: &str, pending: bool) {
    state.emit(QmuxEvent::new(
        "research.recap.pending",
        None,
        None,
        json!({ "nodeId": node_id, "pending": pending }),
    ));
}

/// Select assistant prose after the last tool activity. Keep the most recent
/// text group as a fallback for a trailing housekeeping tool, like the UI fold.
/// Raw reasoning blocks and user/tool payloads never enter the summarizer.
pub fn recap_source_for_node(node: &research::ResearchNode, turns: &[Turn]) -> Option<String> {
    extract_recap_source(turns, node_is_imported(node))
}

#[cfg(test)]
pub fn recap_source(turns: &[Turn]) -> Option<String> {
    extract_recap_source(turns, false)
}

fn extract_recap_source(turns: &[Turn], imported: bool) -> Option<String> {
    let mut text = Vec::new();
    let mut fallback = Vec::new();
    for turn in turns
        .iter()
        .filter(|turn| research::turn_is_in_active_context(turn))
    {
        for block in &turn.blocks {
            match block {
                TurnBlock::Text { text: value }
                    if turn.role == "assistant" && !value.trim().is_empty() =>
                {
                    text.push(value.as_str());
                }
                TurnBlock::ToolUse { .. } | TurnBlock::ToolResult { .. } => {
                    if !text.is_empty() {
                        fallback = std::mem::take(&mut text);
                    }
                }
                _ => {}
            }
        }
    }
    let markdown = if text.is_empty() { fallback } else { text }.join("\n\n");
    let plain = plain_text(&markdown);
    (if imported {
        !plain.is_empty()
    } else {
        plain.chars().count() >= MIN_RECAP_CHARS && plain.len() <= MAX_SOURCE_BYTES
    })
    .then_some(plain)
}

fn plain_text(markdown: &str) -> String {
    // `[[Term]]` markers are renderer machinery; the summarizer sees words.
    let markdown = crate::wikilinks::strip_wikilinks(markdown);
    let mut plain = String::new();
    for event in Parser::new(&markdown) {
        match event {
            Event::Text(text) | Event::Code(text) => plain.push_str(&text),
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::Item
                | TagEnd::TableCell,
            ) => plain.push(' '),
            _ => {}
        }
    }
    plain.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn normalize_recap(raw: &str) -> Option<String> {
    let plain = plain_text(raw);
    let text = plain
        .strip_prefix("Summary:")
        .or_else(|| plain.strip_prefix("summary:"))
        .unwrap_or(&plain)
        .trim();
    // Reject runaway output rather than cutting a caveat mid-sentence.
    (!text.is_empty() && text.chars().count() <= 1_200).then(|| text.to_string())
}

pub fn validate_instructions(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("summary instructions cannot be empty".to_string());
    }
    if value.chars().count() > MAX_RECAP_INSTRUCTIONS_CHARS {
        return Err(format!(
            "summary instructions cannot exceed {MAX_RECAP_INSTRUCTIONS_CHARS} characters"
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, blocks: Vec<TurnBlock>) -> Turn {
        serde_json::from_value(serde_json::json!({
            "id": "test", "agentId": "test", "role": role,
            "blocks": blocks, "sourceIndex": 0,
        }))
        .unwrap()
    }
    fn text(value: &str) -> TurnBlock {
        TurnBlock::Text { text: value.into() }
    }

    #[test]
    fn recap_source_and_output_keep_only_wikilink_display_text() {
        let body = format!(
            "[[Rust]] and [[Tokio|tokio's]] runtime. {}",
            "x".repeat(800)
        );
        let source = recap_source(&[turn("assistant", vec![text(&body)])]).unwrap();
        assert!(source.starts_with("Rust and tokio's runtime."), "{source}");
        assert_eq!(
            normalize_recap("Summary: [[Rust]] wins.").as_deref(),
            Some("Rust wins.")
        );
    }

    #[test]
    fn cutoff_counts_visible_unicode_text_not_link_targets_or_markup() {
        assert!(recap_source(&[turn("assistant", vec![text(&"é".repeat(799))])]).is_none());
        assert!(
            recap_source(&[turn(
                "assistant",
                vec![text(&format!("**{}**", "é".repeat(800)))]
            )])
            .is_some()
        );
        assert!(
            recap_source(&[turn(
                "assistant",
                vec![text(&format!(
                    "[short](https://example.com/{})",
                    "x".repeat(1000)
                ))]
            )])
            .is_none()
        );
    }

    #[test]
    fn source_excludes_prompt_reasoning_and_tool_activity() {
        let tool = TurnBlock::ToolUse {
            id: None,
            name: "search".into(),
            input: serde_json::json!({}),
        };
        let answer = "Final answer. ".repeat(70).trim().to_string();
        let turns = vec![
            turn("user", vec![text(&"question".repeat(200))]),
            turn(
                "assistant",
                vec![text(&"commentary".repeat(200)), tool.clone()],
            ),
            turn(
                "assistant",
                vec![
                    TurnBlock::Raw {
                        value: serde_json::json!({"thinking": "private reasoning"}),
                    },
                    text(&answer),
                ],
            ),
        ];
        assert_eq!(recap_source(&turns), Some(answer.clone()));
        let mut trailing = turns;
        trailing.push(turn("assistant", vec![tool]));
        assert_eq!(recap_source(&trailing), Some(answer));
    }

    #[test]
    fn recap_is_plain_and_bounded() {
        assert_eq!(
            normalize_recap(
                "**Summary:** *Primary result.*\nThen [secondary result](https://example.com)."
            ),
            Some("Primary result. Then secondary result.".into())
        );
        assert!(normalize_recap(" \n ").is_none());
        assert!(normalize_recap(&"x".repeat(1201)).is_none());
    }

    #[test]
    fn custom_instructions_are_nonempty_and_bounded() {
        assert_eq!(
            validate_instructions("  Preserve caveats.  ").unwrap(),
            "Preserve caveats."
        );
        assert!(validate_instructions(" \n ").is_err());
        assert!(validate_instructions(&"x".repeat(MAX_RECAP_INSTRUCTIONS_CHARS + 1)).is_err());
    }
}
