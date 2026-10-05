//! Optional terminal presentation supplied by the desktop. The execution core
//! never initializes AppKit or requires a surface to exist.
use std::sync::{Arc, OnceLock};

pub trait TerminalHost: Send + Sync {
    fn create(&self, id: &str, cwd: Option<&str>) -> Result<(), String>;
    fn receive(&self, id: &str, bytes: &[u8], replay: bool) -> Result<(), String>;
    fn ready(&self, id: &str) -> Result<bool, String>;
    fn remove(&self, id: &str) -> Result<(), String>;
    fn paste(&self, id: &str, text: &str) -> Result<(), String>;
    fn text(&self, id: &str, text: &str) -> Result<(), String>;
    fn submit(&self, id: &str) -> Result<(), String>;
    fn viewport(&self, id: String) -> Result<String, String>;
    fn recent_ctrl_d(&self, id: &str) -> bool;
    fn sound(&self, id: &str) -> Result<(), String>;
}

static HOST: OnceLock<Arc<dyn TerminalHost>> = OnceLock::new();

pub fn install(host: Arc<dyn TerminalHost>) {
    assert!(HOST.set(host).is_ok(), "terminal host already installed");
}

pub fn available() -> bool {
    HOST.get().is_some()
}

fn host() -> Result<&'static dyn TerminalHost, String> {
    HOST.get()
        .map(AsRef::as_ref)
        .ok_or_else(|| "no terminal presentation is attached".into())
}

pub fn create_host_managed(id: &str, cwd: Option<&str>) -> Result<(), String> {
    host()?.create(id, cwd)
}
pub fn receive(id: &str, bytes: &[u8], replay: bool) -> Result<(), String> {
    host()?.receive(id, bytes, replay)
}
pub fn is_ready_for_replay(id: &str) -> Result<bool, String> {
    HOST.get().map_or(Ok(true), |host| host.ready(id))
}
pub fn remove(id: &str) -> Result<(), String> {
    HOST.get().map_or(Ok(()), |host| host.remove(id))
}
pub fn paste_approved_text(id: &str, text: &str) -> Result<(), String> {
    host()?.paste(id, text)
}
pub fn send_text(id: &str, text: &str) -> Result<(), String> {
    host()?.text(id, text)
}
pub fn submit(id: &str) -> Result<(), String> {
    host()?.submit(id)
}
pub fn native_terminal_read_viewport_text(id: String) -> Result<String, String> {
    host()?.viewport(id)
}
pub fn take_recent_remote_ctrl_d(id: &str) -> bool {
    HOST.get().is_some_and(|host| host.recent_ctrl_d(id))
}
pub fn play_completion_sound(id: &str) -> Result<(), String> {
    HOST.get().map_or(Ok(()), |host| host.sound(id))
}
