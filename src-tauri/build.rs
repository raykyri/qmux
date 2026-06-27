use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    println!("cargo:rustc-check-cfg=cfg(qmux_foundation_models)");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    build_foundation_title_bridge();
    tauri_build::build();
}

fn build_foundation_title_bridge() {
    if env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = manifest_dir.join("swift/FoundationTitleGenerator.swift");
    println!("cargo:rerun-if-changed={}", source.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let module_cache = out_dir.join("swift-module-cache");
    let _ = std::fs::create_dir_all(&module_cache);
    let lib_path = out_dir.join("libqmux_foundation_title.a");
    let target = swift_target_triple();

    let mut failures = Vec::new();
    for (swiftc, sdk_path) in swift_toolchain_candidates() {
        if !sdk_path
            .join("System/Library/Frameworks/FoundationModels.framework")
            .exists()
        {
            failures.push(format!(
                "{} has no FoundationModels.framework",
                sdk_path.display()
            ));
            continue;
        }

        let output = Command::new(&swiftc)
            .arg("-parse-as-library")
            .arg("-O")
            .arg("-emit-library")
            .arg("-static")
            .arg("-module-name")
            .arg("QmuxFoundationTitle")
            .arg("-sdk")
            .arg(&sdk_path)
            .arg("-target")
            .arg(&target)
            .arg("-module-cache-path")
            .arg(&module_cache)
            .arg("-o")
            .arg(&lib_path)
            .arg(&source)
            .output();

        match output {
            Ok(output) if output.status.success() => {
                println!("cargo:rustc-cfg=qmux_foundation_models");
                println!("cargo:rustc-link-search=native={}", out_dir.display());
                if let Some(swift_library_path) = swift_platform_library_path(&swiftc) {
                    println!(
                        "cargo:rustc-link-search=native={}",
                        swift_library_path.display()
                    );
                }
                println!("cargo:rustc-link-lib=static=qmux_foundation_title");
                println!("cargo:rustc-link-lib=framework=Foundation");
                println!("cargo:rustc-link-arg=-Wl,-weak_framework,FoundationModels");
                println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
                return;
            }
            Ok(output) => failures.push(format!(
                "{} failed: {}",
                swiftc.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) => failures.push(format!("{} failed to start: {err}", swiftc.display())),
        }
    }

    let details = if failures.is_empty() {
        "no Swift toolchain candidates found".to_string()
    } else {
        failures.join("; ")
    };
    let message = format!("Apple Foundation Models tab-title bridge disabled: {details}");
    if is_release_build() {
        panic!("{message}");
    }
    println!("cargo:warning={message}");
}

fn is_release_build() -> bool {
    env::var("PROFILE").ok().as_deref() == Some("release")
}

fn swift_target_triple() -> String {
    let arch = match env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_default()
        .as_str()
    {
        "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    };
    let min_version = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "13.0".to_string());
    format!("{arch}-apple-macosx{min_version}")
}

fn swift_toolchain_candidates() -> Vec<(PathBuf, PathBuf)> {
    let mut candidates = Vec::new();

    if let Ok(developer_dir) = env::var("DEVELOPER_DIR") {
        push_developer_dir_candidate(&mut candidates, Path::new(&developer_dir));
    }

    if let (Some(swiftc), Some(sdk_path)) = (
        xcrun_path(&["--find", "swiftc"]),
        xcrun_path(&["--sdk", "macosx", "--show-sdk-path"]),
    ) {
        push_unique_candidate(&mut candidates, swiftc, sdk_path);
    }

    push_developer_dir_candidate(
        &mut candidates,
        Path::new("/Applications/Xcode.app/Contents/Developer"),
    );

    candidates
}

fn swift_platform_library_path(swiftc: &Path) -> Option<PathBuf> {
    let usr_dir = swiftc.parent()?.parent()?;
    let library_path = usr_dir.join("lib/swift/macosx");
    library_path.exists().then_some(library_path)
}

fn push_developer_dir_candidate(candidates: &mut Vec<(PathBuf, PathBuf)>, developer_dir: &Path) {
    let swiftc = developer_dir.join("Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc");
    let sdk_path = developer_dir.join("Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk");
    if swiftc.exists() && sdk_path.exists() {
        push_unique_candidate(candidates, swiftc, sdk_path);
    }
}

fn push_unique_candidate(
    candidates: &mut Vec<(PathBuf, PathBuf)>,
    swiftc: PathBuf,
    sdk_path: PathBuf,
) {
    if candidates.iter().any(|(existing_swiftc, existing_sdk)| {
        existing_swiftc == &swiftc && existing_sdk == &sdk_path
    }) {
        return;
    }
    candidates.push((swiftc, sdk_path));
}

fn xcrun_path(args: &[&str]) -> Option<PathBuf> {
    let output = Command::new("xcrun").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
