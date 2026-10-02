//! Pane-scoped credentials, file-preview grants, and their revocation.
//! AppState retains the same shared model and lock ownership.

use super::*;

impl AppState {
    /// Returns the read-only file-preview token scoped to one pane.
    pub fn pane_file_token(&self, pane_id: &str) -> Result<String, String> {
        let mut tokens = self
            .inner
            .file_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.get(pane_id) {
            return Ok(existing.clone());
        }
        let token = random_token()?;
        Ok(tokens.entry(pane_id.to_string()).or_insert(token).clone())
    }

    pub fn pane_for_file_token(&self, token: &str) -> Option<String> {
        let tokens = self
            .inner
            .file_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .iter()
            .find_map(|(pane_id, pane_token)| (pane_token == token).then(|| pane_id.clone()))
    }

    pub fn exact_file_preview_token(
        &self,
        pane_id: &str,
        path: &std::path::Path,
    ) -> Result<String, String> {
        if !self.pane_exists(pane_id)? {
            return Err(format!("pane {pane_id} was not found"));
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|err| format!("failed to resolve {}: {err}", path.display()))?;
        if !canonical.is_file() {
            return Err(format!("{} is not a file", canonical.display()));
        }
        let mut tokens = self
            .inner
            .exact_file_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.iter().find_map(|(token, (owner, source))| {
            (owner == pane_id && source == &canonical).then(|| token.clone())
        }) {
            return Ok(existing);
        }
        let token = random_token()?;
        tokens.insert(token.clone(), (pane_id.to_string(), canonical));
        Ok(token)
    }

    pub fn exact_file_for_preview_token(
        &self,
        token: &str,
    ) -> Option<(String, std::path::PathBuf)> {
        self.inner
            .exact_file_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(token)
            .cloned()
    }

    /// Add one exact file to a pane's read-only preview capability. The caller
    /// must perform its own semantic authorization first (for example, proving
    /// a Codex visualization belongs to this pane's session); canonicalizing
    /// here makes the eventual file-server comparison resistant to `..` and
    /// symlink swaps.
    pub fn grant_pane_file_preview(
        &self,
        pane_id: &str,
        path: &std::path::Path,
    ) -> Result<std::path::PathBuf, String> {
        if !self.pane_exists(pane_id)? {
            return Err(format!("pane {pane_id} was not found"));
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|err| format!("failed to resolve {}: {err}", path.display()))?;
        if !canonical.is_file() {
            return Err(format!("{} is not a file", canonical.display()));
        }
        let mut grants = self
            .inner
            .file_preview_grants
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        grants
            .entry(pane_id.to_string())
            .or_default()
            .insert(canonical.clone());
        Ok(canonical)
    }

    pub fn pane_file_preview_grants(&self, pane_id: &str) -> Vec<std::path::PathBuf> {
        self.inner
            .file_preview_grants
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(pane_id)
            .map(|paths| paths.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Roots a preview from a pane may read. This deliberately excludes other
    /// qmux groups and any cwd at or above the private workspace root. Local
    /// temporary directories are explicit shared roots because agents commonly
    /// write disposable HTML artifacts there rather than beneath their cwd.
    pub fn pane_file_roots(&self, pane_id: &str) -> Vec<std::path::PathBuf> {
        self.pane_file_roots_inner(pane_id, true)
    }

    /// Project roots for a filename search. Shared temporary directories are
    /// valid for explicit previews, but far too broad for a basename lookup.
    pub fn pane_file_search_roots(&self, pane_id: &str) -> Vec<std::path::PathBuf> {
        self.pane_file_roots_inner(pane_id, false)
    }

    pub(super) fn pane_file_roots_inner(
        &self,
        pane_id: &str,
        include_temporary: bool,
    ) -> Vec<std::path::PathBuf> {
        let model = self
            .inner
            .model
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(pane) = model.panes.get(pane_id) {
            // A remote group's dir and cwd are paths on its host. Serving them
            // through the local file server would resolve those strings against
            // the local filesystem — at best a wrong file, at worst a same-named
            // local path leaking into a preview. Remote panes get no roots.
            if model
                .groups
                .get(&pane.info.group_id)
                .is_some_and(GroupInfo::is_remote)
            {
                return Vec::new();
            }
            let mut roots = Vec::new();
            let group_dir = model
                .groups
                .get(&pane.info.group_id)
                .map(|group| std::path::PathBuf::from(&group.dir));
            if let Some(group_dir) = &group_dir {
                roots.push(group_dir.clone());
            }
            let cwd = std::path::PathBuf::from(&pane.info.cwd);
            let workspace_root = &self.inner.config.workspace_root;
            let cwd_at_or_above_workspace = path_is_ancestor_or_equal(&cwd, workspace_root);
            let cwd_inside_workspace = path_is_ancestor_or_equal(workspace_root, &cwd);
            let cwd_under_own_group = group_dir
                .as_deref()
                .is_some_and(|group_dir| path_is_ancestor_or_equal(group_dir, &cwd));
            if !cwd_at_or_above_workspace && (!cwd_inside_workspace || cwd_under_own_group) {
                roots.push(cwd);
            }
            for agent in model.agents.values() {
                if agent.pane_id.as_deref() == Some(pane_id) {
                    roots.push(std::path::PathBuf::from(&agent.worktree_dir));
                }
            }
            // Include both conventional macOS spellings even though `/tmp`
            // normally canonicalizes to `/private/tmp`; `temp_dir` also covers
            // a host whose configured temporary directory lives elsewhere.
            if include_temporary {
                for temp_root in [
                    std::env::temp_dir(),
                    std::path::PathBuf::from("/tmp"),
                    std::path::PathBuf::from("/private/tmp"),
                ] {
                    if !roots.contains(&temp_root) {
                        roots.push(temp_root);
                    }
                }
            }
            return roots;
        }
        Vec::new()
    }

    /// Returns the control-socket token scoped to a single pane, minting one on first
    /// use. Each pane gets its own unguessable token so a process running in one pane
    /// cannot drive another pane (or the control plane) through the socket.
    pub fn pane_token(&self, pane_id: &str) -> Result<String, String> {
        let mut tokens = self
            .inner
            .pane_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.get(pane_id) {
            return Ok(existing.clone());
        }
        // Mint outside the entry API so a CSPRNG failure returns an error to this one
        // call rather than panicking inside or_insert_with and aborting the whole
        // app (killing every running agent and unsaved draft).
        let token = random_token()?;
        Ok(tokens.entry(pane_id.to_string()).or_insert(token).clone())
    }

    /// Resolves the pane a presented control token is authorized for, if any.
    pub fn pane_for_token(&self, token: &str) -> Option<String> {
        let tokens = self
            .inner
            .pane_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .iter()
            .find_map(|(pane_id, pane_token)| (pane_token == token).then(|| pane_id.clone()))
    }

    /// Returns the restricted control credential injected into a remote pane.
    /// It deliberately has a separate namespace from `pane_token`: callers on
    /// the far side of SSH must pass the remote command policy in control_socket.
    pub fn pane_remote_token(&self, pane_id: &str) -> Result<String, String> {
        let mut tokens = self
            .inner
            .remote_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.get(pane_id) {
            return Ok(existing.clone());
        }
        let token = random_token()?;
        Ok(tokens.entry(pane_id.to_string()).or_insert(token).clone())
    }

    /// Whether this process already knows the surviving remote pane's token.
    pub(crate) fn has_pane_remote_token(&self, pane_id: &str) -> bool {
        self.inner
            .remote_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .contains_key(pane_id)
    }

    /// Restore only remote authority from the authenticated SSH session being
    /// reattached. Never let a host rebind another pane's or a local credential.
    pub(crate) fn restore_pane_remote_token(
        &self,
        pane_id: &str,
        token: &str,
    ) -> Result<(), String> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("remote session has an invalid hook credential".into());
        }
        if self.pane_for_token(token).is_some() || self.pane_for_user_token(token).is_some() {
            return Err("remote hook credential conflicts with local authority".into());
        }
        // Hold the model lock until registration completes so removal cannot
        // revoke the token and then have a late recovery put it back.
        let model = self.inner.model.lock().map_err(|_| "model lock poisoned")?;
        if !model
            .panes
            .get(pane_id)
            .is_some_and(|pane| pane.info.recovered && pane.info.remote_session.is_some())
        {
            return Err("hook credential recovery requires a surviving remote pane".into());
        }
        let mut tokens = self
            .inner
            .remote_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if tokens
            .iter()
            .any(|(id, value)| id != pane_id && value == token)
        {
            return Err("remote hook credential belongs to another pane".into());
        }
        if let Some(existing) = tokens.get(pane_id) {
            return if existing == token {
                Ok(())
            } else {
                Err("remote hook credential changed during recovery".into())
            };
        }
        tokens.insert(pane_id.to_string(), token.to_string());
        Ok(())
    }

    /// Resolves a restricted SSH-forwarded credential to its owning pane.
    pub fn pane_for_remote_token(&self, token: &str) -> Option<String> {
        let tokens = self
            .inner
            .remote_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .iter()
            .find_map(|(pane_id, pane_token)| (pane_token == token).then(|| pane_id.clone()))
    }

    pub fn pane_user_token(&self, pane_id: &str) -> Result<String, String> {
        let mut tokens = self
            .inner
            .user_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        if let Some(existing) = tokens.get(pane_id) {
            return Ok(existing.clone());
        }
        let token = random_token()?;
        Ok(tokens.entry(pane_id.to_string()).or_insert(token).clone())
    }

    pub fn pane_for_user_token(&self, token: &str) -> Option<String> {
        let tokens = self
            .inner
            .user_tokens
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        tokens
            .iter()
            .find_map(|(pane_id, pane_token)| (pane_token == token).then(|| pane_id.clone()))
    }

    pub(super) fn revoke_pane_credentials(&self, pane_id: &str) {
        // Pane credentials are captured by in-pane processes; once the pane is gone
        // for good they can never legitimately be used again. Revoke every namespace
        // rather than leave a credential resolving to a pane that no longer exists.
        // These locks stay separate from `model`.
        if let Ok(mut tokens) = self.inner.pane_tokens.lock() {
            tokens.remove(pane_id);
        }
        if let Ok(mut tokens) = self.inner.remote_tokens.lock() {
            tokens.remove(pane_id);
        }
        if let Ok(mut tokens) = self.inner.user_tokens.lock() {
            tokens.remove(pane_id);
        }
        if let Ok(mut tokens) = self.inner.file_tokens.lock() {
            tokens.remove(pane_id);
        }
        if let Ok(mut tokens) = self.inner.exact_file_tokens.lock() {
            tokens.retain(|_, (owner, _)| owner != pane_id);
        }
        if let Ok(mut grants) = self.inner.file_preview_grants.lock() {
            grants.remove(pane_id);
        }
        // Drop the pane's send lock so the map doesn't grow for the process lifetime.
        // Separate lock from `model`.
        if let Ok(mut locks) = self.inner.pane_send_locks.lock() {
            locks.remove(pane_id);
        }
    }
}
