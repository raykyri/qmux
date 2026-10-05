//! Desktop-independent qmux execution and conversation core.
//! Build and test with `--no-default-features --lib`; the desktop installs
//! a terminal host while a service can own terminal state without a window.

pub mod adapters;
pub mod claude_sdk;
pub mod completion_sound;
pub mod config;
pub mod connection_limit;
pub mod control;
pub mod control_socket;
pub mod events;
pub mod file_server;
pub mod headless_process;
pub mod history;
pub mod host;
pub mod image_files;
pub mod journal;
pub mod launch_path;
pub mod local_terminal;
pub mod mcp;
pub mod persistence;
pub mod prompt_library;
pub mod pty;
pub mod recovery;
pub mod remote_cli;
pub mod remote_files;
pub mod remote_preview;
pub mod remote_process;
pub mod remote_terminal;
pub mod remote_transcript;
pub mod remote_transport;
pub mod research;
pub mod research_runtime;
pub mod scrollback;
pub mod shell_jobs;
pub mod ssh_config;
pub mod state;
pub mod thread_graph;
pub mod title_generation;
pub mod transcript;
pub mod turn_queue;
pub mod user_notifications;
pub mod workspace;

#[path = "runtime_terminal.rs"]
pub mod native_terminal;

pub fn ensure_rustls_crypto_provider() -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or_else(|| "failed to install the rustls ring crypto provider".to_string())
}
