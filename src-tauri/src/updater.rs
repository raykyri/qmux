//! Startup update check against the GitHub releases feed (see the `updater`
//! plugin config in tauri.conf.json). The whole flow is best-effort: a failed
//! or offline check only logs to stderr and never blocks startup.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// Kicks off a background update check. Dev builds skip it so `tauri dev`
/// doesn't hit GitHub (and can't be offered a "newer" release build anyway).
pub fn check_on_startup(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = check_and_prompt(app).await {
            eprintln!("qmux: update check failed: {err}");
        }
    });
}

async fn check_and_prompt(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let Some(update) = updater.check().await.map_err(|err| err.to_string())? else {
        return Ok(());
    };

    let message = format!(
        "qmux {} is available (you have {}).\n\nDownload and install it now?",
        update.version,
        app.package_info().version
    );
    if !ask(&app, "Update Available", &message, "Install", "Later").await? {
        return Ok(());
    }

    update
        .download_and_install(|_received, _total| {}, || {})
        .await
        .map_err(|err| err.to_string())?;

    if ask(
        &app,
        "Update Installed",
        "The update will take effect the next time qmux starts.\n\nRestart now?",
        "Restart",
        "Not Now",
    )
    .await?
    {
        app.restart();
    }
    Ok(())
}

/// Shows a two-button dialog without tying up the async runtime: the dialog
/// plugin only offers a blocking wait, so it runs on a blocking thread.
async fn ask(
    app: &AppHandle,
    title: &str,
    message: &str,
    confirm: &str,
    cancel: &str,
) -> Result<bool, String> {
    let dialog = app
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm.to_string(),
            cancel.to_string(),
        ));
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|err| format!("update dialog task failed: {err}"))
}
