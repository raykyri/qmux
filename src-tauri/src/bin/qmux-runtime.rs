//! Standalone runtime and diagnostic client. No window or GUI event loop.
use qmux::{config::QmuxConfig, runtime_rpc::RuntimeClient, runtime_service::RuntimeService};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    // Agent hooks use this executable through the qmux PATH shim, but runtime
    // subcommands are outside the pane-scoped CLI's command grammar.
    if !args
        .first()
        .is_some_and(|arg| matches!(arg.as_str(), "serve" | "snapshot" | "call" | "stop"))
    {
        if qmux_cli::run_cli_if_requested()? {
            return Ok(());
        }
    }
    qmux::ensure_rustls_crypto_provider()?;
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["serve", root] => {
            unsafe {
                libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
                libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
            }
            let service = RuntimeService::start(QmuxConfig::load()?, Path::new(root))?;
            eprintln!("qmux-runtime: ready at {root}");
            while !STOP.load(Ordering::Relaxed) && !service.shutdown_requested() {
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(service);
        }
        ["snapshot", root] => println!("{}", RuntimeClient::connect(Path::new(root))?.snapshot()?),
        ["call", root, method, arguments] => {
            let args = serde_json::from_str(arguments).map_err(|e| format!("invalid arguments: {e}"))?;
            println!("{}", RuntimeClient::connect(Path::new(root))?.call(method, args)?);
        }
        ["stop", root] => { RuntimeClient::connect(Path::new(root))?.call("runtime_shutdown", serde_json::json!({}))?; }
        _ => return Err("usage: qmux-runtime serve|snapshot|stop RUNTIME_DIR; qmux-runtime call RUNTIME_DIR METHOD JSON_ARGUMENTS".into()),
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("qmux-runtime: {error}");
        std::process::exit(1);
    }
}
