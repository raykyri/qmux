//! Journal mutations and the combined recent-activity feed.
//! AppState retains the same shared model and lock ownership.

use super::*;

impl AppState {
    #[cfg(test)]
    pub fn journal(&self) -> Result<journal::JournalState, String> {
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        Ok(model.journal.clone())
    }

    /// Replaces the stored journal with a client-supplied one, mirroring
    /// `set_research_folders`: structural normalization only (the frontend
    /// owns the entry format), last write wins, and the frontend adopts the
    /// normalized state returned.
    #[cfg(test)]
    pub fn set_journal(
        &self,
        mut state: journal::JournalState,
    ) -> Result<journal::JournalState, String> {
        journal::normalize_journal_state(&mut state);
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model.journal == state {
                return Ok(state);
            }
            model.journal = state.clone();
        }
        self.persist();
        Ok(state)
    }

    pub fn append_journal_entry(&self, entry: serde_json::Value) -> Result<bool, String> {
        let id = journal::entry_id(&entry)
            .ok_or_else(|| "journal entry must have a non-empty string id".to_string())?
            .to_string();
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model
                .journal
                .entries
                .iter()
                .any(|candidate| journal::entry_id(candidate) == Some(id.as_str()))
            {
                return Ok(false);
            }
            model.journal.entries.push(entry);
        }
        self.persist();
        Ok(true)
    }

    pub fn restore_journal_entry(&self, entry: serde_json::Value) -> Result<bool, String> {
        let id = journal::entry_id(&entry)
            .ok_or_else(|| "journal entry must have a non-empty string id".to_string())?
            .to_string();
        let occurred_at = journal::entry_occurred_at(&entry);
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            if model
                .journal
                .entries
                .iter()
                .any(|candidate| journal::entry_id(candidate) == Some(id.as_str()))
            {
                return Ok(false);
            }
            let position = model
                .journal
                .entries
                .iter()
                .position(|candidate| journal::entry_occurred_at(candidate) > occurred_at)
                .unwrap_or(model.journal.entries.len());
            model.journal.entries.insert(position, entry);
        }
        self.persist();
        Ok(true)
    }

    pub fn update_journal_entry(&self, id: &str, entry: serde_json::Value) -> Result<bool, String> {
        if journal::entry_id(&entry) != Some(id) {
            return Err("replacement journal entry id does not match".to_string());
        }
        {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let Some(candidate) = model
                .journal
                .entries
                .iter_mut()
                .find(|candidate| journal::entry_id(candidate) == Some(id))
            else {
                return Ok(false);
            };
            if candidate == &entry {
                return Ok(false);
            }
            *candidate = entry;
        }
        self.persist();
        Ok(true)
    }

    pub fn remove_journal_entry(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut model = self
                .inner
                .model
                .lock()
                .map_err(|_| "model lock poisoned".to_string())?;
            let before = model.journal.entries.len();
            model
                .journal
                .entries
                .retain(|candidate| journal::entry_id(candidate) != Some(id));
            model.journal.entries.len() != before
        };
        if removed {
            self.persist();
        }
        Ok(removed)
    }

    pub fn list_recent_activity(
        &self,
        limit: usize,
        before: Option<RecentActivityCursor>,
    ) -> Result<RecentActivityPage, String> {
        enum ActivityPayload<'a> {
            Journal(&'a serde_json::Value),
            Research(&'a ResearchNode),
        }

        struct Candidate<'a> {
            occurred_at: u128,
            source_rank: u8,
            id: &'a str,
            payload: ActivityPayload<'a>,
        }

        impl Candidate<'_> {
            fn is_before(&self, cursor: &RecentActivityCursor) -> bool {
                self.occurred_at < cursor.occurred_at
                    || (self.occurred_at == cursor.occurred_at
                        && (self.source_rank < cursor.source_rank
                            || (self.source_rank == cursor.source_rank
                                && self.id < cursor.id.as_str())))
            }
        }

        let compare = |left: &Candidate<'_>, right: &Candidate<'_>| {
            right
                .occurred_at
                .cmp(&left.occurred_at)
                .then_with(|| right.source_rank.cmp(&left.source_rank))
                .then_with(|| right.id.cmp(left.id))
        };
        let model = self
            .inner
            .model
            .lock()
            .map_err(|_| "model lock poisoned".to_string())?;
        let mut candidates = model
            .journal
            .entries
            .iter()
            .filter_map(|entry| {
                journal::entry_id(entry).map(|id| Candidate {
                    occurred_at: journal::entry_occurred_at(entry),
                    source_rank: JOURNAL_ACTIVITY_SOURCE_RANK,
                    id,
                    payload: ActivityPayload::Journal(entry),
                })
            })
            .chain(model.research_nodes.values().filter_map(|node| {
                (node.kind.is_run() && model.research_trees.contains_key(&node.tree_id)).then_some(
                    Candidate {
                        occurred_at: node.created_at,
                        source_rank: RESEARCH_ACTIVITY_SOURCE_RANK,
                        id: &node.id,
                        payload: ActivityPayload::Research(node),
                    },
                )
            }))
            .filter(|candidate| {
                before
                    .as_ref()
                    .is_none_or(|cursor| candidate.is_before(cursor))
            })
            .collect::<Vec<_>>();
        let page_size = limit.clamp(1, 100);
        let has_more = candidates.len() > page_size;
        if has_more {
            candidates.select_nth_unstable_by(page_size, compare);
            candidates.truncate(page_size);
        }
        candidates.sort_by(compare);
        let next_cursor = has_more.then(|| {
            let last = candidates
                .last()
                .expect("a non-empty limited activity page");
            RecentActivityCursor {
                occurred_at: last.occurred_at,
                source_rank: last.source_rank,
                id: last.id.to_string(),
            }
        });
        let items = candidates
            .into_iter()
            .map(|candidate| match candidate.payload {
                ActivityPayload::Journal(entry) => RecentActivityItem::Journal {
                    occurred_at: candidate.occurred_at,
                    entry: entry.clone(),
                },
                ActivityPayload::Research(node) => RecentActivityItem::ResearchQuery {
                    occurred_at: candidate.occurred_at,
                    query: RecentResearchQuery::from(node),
                },
            })
            .collect();
        Ok(RecentActivityPage { items, next_cursor })
    }
}
