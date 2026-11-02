use super::AppState;
use std::time::{Duration, Instant};

// Longer than the frontend's 1500 ms inactivity debounce. Keystrokes renew this
// lease; a lost release can hold a queue for at most this interval plus one tick.
pub(crate) const TYPING_LEASE: Duration = Duration::from_secs(5);

pub(super) struct TypingUpdate {
    sequence: u64,
    pub(super) deadline: Option<Instant>,
}

impl AppState {
    pub fn agent_typing_document(&self) -> Result<String, String> {
        let model = self.inner.model.lock().map_err(|_| "model lock poisoned")?;
        Ok(model.agent_typing_document.to_string())
    }

    /// Invalidate commands already dispatched by the old document, including true
    /// commands that have not reached the model lock yet. Do not reset the expiry
    /// worker flag: an existing worker also services replacement-document holds.
    pub fn invalidate_agent_typing_document(&self) -> Result<Vec<String>, String> {
        let mut model = self.inner.model.lock().map_err(|_| "model lock poisoned")?;
        model.agent_typing_document = model.agent_typing_document.wrapping_add(1);
        model.agent_typing_updates.clear();
        Ok(model.agent_typing.drain().collect())
    }

    /// Returns (accepted, start_expiry_worker). Sequence tombstones survive both
    /// release and expiry so a delayed earlier true cannot recreate a hold.
    pub fn update_agent_typing(
        &self,
        agent_id: &str,
        document: &str,
        sequence: u64,
        typing: bool,
    ) -> Result<(bool, bool), String> {
        let mut model = self.inner.model.lock().map_err(|_| "model lock poisoned")?;
        if document != model.agent_typing_document.to_string() {
            return Err("typing document expired".to_string());
        }
        if !model.agents.contains_key(agent_id)
            || model
                .agent_typing_updates
                .get(agent_id)
                .is_some_and(|update| sequence <= update.sequence)
        {
            return Ok((false, false));
        }
        model.agent_typing_updates.insert(
            agent_id.to_string(),
            TypingUpdate {
                sequence,
                deadline: typing.then(|| Instant::now() + TYPING_LEASE),
            },
        );
        if typing {
            model.agent_typing.insert(agent_id.to_string());
        } else {
            model.agent_typing.remove(agent_id);
        }
        let start_worker = typing && !model.agent_typing_expiry_running;
        if start_worker {
            model.agent_typing_expiry_running = true;
        }
        Ok((true, start_worker))
    }

    /// Clear only expired leases at this instant. The later wake must recheck the
    /// gate: a new keystroke can install a replacement hold after this lock drops.
    pub fn expire_agent_typing(&self, now: Instant) -> Result<(Vec<String>, bool), String> {
        let mut model = self.inner.model.lock().map_err(|_| "model lock poisoned")?;
        let mut expired = Vec::new();
        let mut keep_running = false;
        for (agent_id, update) in &mut model.agent_typing_updates {
            if update.deadline.is_some_and(|deadline| deadline <= now) {
                update.deadline = None;
                expired.push(agent_id.clone());
            }
            keep_running |= update.deadline.is_some();
        }
        for agent_id in &expired {
            model.agent_typing.remove(agent_id);
        }
        model.agent_typing_expiry_running = keep_running;
        Ok((expired, keep_running))
    }
}
