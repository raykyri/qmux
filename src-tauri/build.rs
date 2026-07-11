use std::{
    cmp::Ordering,
    env,
    path::{Path, PathBuf},
    process::Command,
};

const MIN_SWIFT_DEPLOYMENT_TARGET: &str = "11.3";

fn main() {
    println!("cargo:rustc-check-cfg=cfg(qmux_foundation_models)");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    println!("cargo:rerun-if-env-changed=QMUX_REQUIRE_FOUNDATION_MODELS");
    println!("cargo:rerun-if-env-changed=QMUX_ALLOW_MISSING_FOUNDATION_MODELS");
    build_native_terminal_bridge();
    build_foundation_title_bridge();
    tauri_build::build();
}

fn build_native_terminal_bridge() {
    if env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let package_dir = manifest_dir.join("swift-terminal");
    let dependency_source_dir = manifest_dir.join("../vendor/libghostty-spm");
    // Emitting any rerun-if-changed disables cargo's default build-script
    // watch, so re-add build.rs itself, and watch the vendored Ghostty
    // sources: this script copies and compiles them, and a source-only change
    // would otherwise never rerun it, silently linking a stale bridge.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", package_dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        dependency_source_dir.join("Package.swift").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        dependency_source_dir.join("Sources").display()
    );

    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("target"));
    let native_build_root = target_dir.join("native-terminal");
    let scratch = native_build_root.join("swiftpm");
    let cache = native_build_root.join("cache");
    let module_cache = native_build_root.join("module-cache");
    let config = native_build_root.join("config");
    let security = native_build_root.join("security");
    let dependency_patch = package_dir.join("Patches/libghostty-spm-qmux.patch");
    println!("cargo:rerun-if-changed={}", dependency_patch.display());
    for dir in [&scratch, &cache, &module_cache, &config, &security] {
        std::fs::create_dir_all(dir).unwrap_or_else(|err| {
            panic!(
                "failed to create native-terminal build directory {}: {err}",
                dir.display()
            )
        });
    }
    let dependency_dir = prepare_patched_ghostty_dependency(
        &dependency_source_dir,
        &native_build_root.join("libghostty-spm"),
        &dependency_patch,
    );

    let deployment_target = swift_deployment_target();
    let target = swift_target_triple(&deployment_target);
    let swift = xcrun_path(&["--find", "swift"])
        .or_else(|| Some(PathBuf::from("swift")))
        .expect("Swift is required to build the native terminal bridge");

    let mut failures = Vec::new();
    for sdk_path in native_terminal_sdk_candidates() {
        let output = Command::new(&swift)
            .env("SDKROOT", &sdk_path)
            .env("QMUX_GHOSTTY_PACKAGE_PATH", &dependency_dir)
            .env("CLANG_MODULE_CACHE_PATH", &module_cache)
            .env("SWIFTPM_MODULECACHE_OVERRIDE", &module_cache)
            .arg("build")
            .arg("--package-path")
            .arg(&package_dir)
            .arg("--configuration")
            .arg("release")
            .arg("--triple")
            .arg(&target)
            .arg("--scratch-path")
            .arg(&scratch)
            .arg("--cache-path")
            .arg(&cache)
            .arg("--config-path")
            .arg(&config)
            .arg("--security-path")
            .arg(&security)
            .output();

        match output {
            Ok(output) if output.status.success() => {
                let arch = target.split('-').next().unwrap_or("arm64");
                let products = scratch.join(format!("{arch}-apple-macosx/release"));
                let bridge = products.join("libQmuxNativeTerminal.a");
                let ghostty = products.join("libghostty.a");
                if !bridge.exists() || !ghostty.exists() {
                    failures.push(format!(
                        "SwiftPM succeeded with SDK {} but did not produce {} and {}",
                        sdk_path.display(),
                        bridge.display(),
                        ghostty.display()
                    ));
                    continue;
                }

                // Fold the bridge archive's identity into the build-script
                // output: cargo only relinks the binary when this output
                // changes, so without it a rebuilt archive with byte-identical
                // link flags leaves a stale bridge inside the shipped binary.
                let bridge_stamp = fs_metadata_stamp(&bridge);
                println!("cargo:rustc-env=QMUX_NATIVE_BRIDGE_STAMP={bridge_stamp}");
                println!("cargo:rustc-link-search=native={}", products.display());
                // force_load, not -l: GhosttyTerminal implements NSView
                // overrides (keyDown, performKeyEquivalent, mouse events) in
                // Swift extensions, which compile to ObjC categories inside
                // archive members no symbol references statically. A plain -l
                // link drops those members and the runtime silently falls back
                // to NSView's defaults — rendering works, keyboard input dies.
                println!("cargo:rustc-link-arg=-Wl,-force_load,{}", bridge.display());
                println!("cargo:rustc-link-lib=static=ghostty");
                println!("cargo:rustc-link-lib=c++");
                for framework in [
                    "AppKit",
                    "Carbon",
                    "CoreFoundation",
                    "CoreGraphics",
                    "CoreText",
                    "CoreVideo",
                    "Foundation",
                    "IOSurface",
                    "Metal",
                    "QuartzCore",
                    "Security",
                    "WebKit",
                ] {
                    println!("cargo:rustc-link-lib=framework={framework}");
                }
                println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
                return;
            }
            Ok(output) => failures.push(format!(
                "SDK {} failed: stdout: {}; stderr: {}",
                sdk_path.display(),
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) => failures.push(format!(
                "failed to start {} with SDK {}: {err}",
                swift.display(),
                sdk_path.display()
            )),
        }
    }

    panic!(
        "failed to build the native Ghostty terminal bridge: {}",
        failures.join("; ")
    );
}

/// Size + mtime stamp of a build product, used to make the build-script output
/// (and therefore cargo's link fingerprint) track the product's content.
fn fs_metadata_stamp(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            format!("{}-{}", meta.len(), mtime)
        }
        Err(_) => "missing".to_string(),
    }
}

fn prepare_patched_ghostty_dependency(source: &Path, destination: &Path, patch: &Path) -> PathBuf {
    if destination.exists() {
        std::fs::remove_dir_all(destination).unwrap_or_else(|err| {
            panic!(
                "failed to clear patched Ghostty package {}: {err}",
                destination.display()
            )
        });
    }
    copy_package_tree(source, destination);
    let output = Command::new("/usr/bin/patch")
        .current_dir(destination)
        .arg("-p1")
        .arg("--forward")
        .arg("--input")
        .arg(patch)
        .output()
        .unwrap_or_else(|err| panic!("failed to start patch for {}: {err}", patch.display()));
    if !output.status.success() {
        panic!(
            "failed to patch Ghostty package: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    destination.to_path_buf()
}

fn copy_package_tree(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap_or_else(|err| {
        panic!(
            "failed to create patched package directory {}: {err}",
            destination.display()
        )
    });
    for entry in std::fs::read_dir(source)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", source.display()))
    {
        let entry = entry.unwrap_or_else(|err| panic!("failed to read package entry: {err}"));
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".git" | ".build" | "Example")) {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(name);
        if source_path.is_dir() {
            copy_package_tree(&source_path, &destination_path);
        } else {
            std::fs::copy(&source_path, &destination_path).unwrap_or_else(|err| {
                panic!(
                    "failed to copy {} to {}: {err}",
                    source_path.display(),
                    destination_path.display()
                )
            });
        }
    }
}

fn native_terminal_sdk_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(sdk) = env::var_os("SDKROOT").map(PathBuf::from)
        && sdk.exists()
    {
        candidates.push(sdk);
    }

    // Command Line Tools installations can temporarily contain a newer SDK than
    // their Swift compiler supports after an OS update. Try every versioned SDK
    // oldest-first — the caller falls back through candidates on build failure,
    // so the stable SDK is preferred and a too-new one still gets attempted —
    // then the unversioned symlink, then the active SDK selected by xcrun.
    for sdk in command_line_tools_sdks() {
        if !candidates.contains(&sdk) {
            candidates.push(sdk);
        }
    }
    let symlinked = PathBuf::from("/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk");
    if symlinked.exists() && !candidates.contains(&symlinked) {
        candidates.push(symlinked);
    }
    if let Some(sdk) = xcrun_path(&["--sdk", "macosx", "--show-sdk-path"])
        && !candidates.contains(&sdk)
    {
        candidates.push(sdk);
    }
    candidates
}

/// Versioned `MacOSX<version>.sdk` directories under the Command Line Tools
/// install, sorted oldest-first. Skips symlinks (`MacOSX.sdk`, `MacOSX15.sdk`)
/// so each real SDK appears once.
fn command_line_tools_sdks() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/Library/Developer/CommandLineTools/SDKs") else {
        return Vec::new();
    };
    let mut sdks: Vec<(Vec<u32>, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|file_type| !file_type.is_symlink())
        })
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version = name.strip_prefix("MacOSX")?.strip_suffix(".sdk")?;
            let version = version
                .split('.')
                .map(str::parse)
                .collect::<Result<Vec<u32>, _>>()
                .ok()?;
            Some((version, entry.path()))
        })
        .collect();
    sdks.sort();
    sdks.into_iter().map(|(_, path)| path).collect()
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
    let deployment_target = swift_deployment_target();
    let target = swift_target_triple(&deployment_target);

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
            .env("MACOSX_DEPLOYMENT_TARGET", &deployment_target)
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
    if foundation_models_required() {
        panic!("{message}");
    }
    println!("cargo:warning={message}");
}

/// Whether a missing Swift bridge should fail the build rather than just warn.
///
/// Fail-closed on release by default: any release build (not only `scripts/build.sh`)
/// must ship the bridge, so a bundle produced by a plain `cargo tauri build` or a new
/// CI job can't silently lose tab-title generation. Debug builds stay optional so a
/// checkout without a Swift toolchain still compiles.
///
/// `QMUX_REQUIRE_FOUNDATION_MODELS=1` forces it on for any profile (belt-and-suspenders
/// for the release script); `QMUX_ALLOW_MISSING_FOUNDATION_MODELS=1` is the opt-out for
/// a contributor who needs a local release build without a Swift toolchain.
fn foundation_models_required() -> bool {
    if env_flag_enabled("QMUX_REQUIRE_FOUNDATION_MODELS") {
        return true;
    }
    if env_flag_enabled("QMUX_ALLOW_MISSING_FOUNDATION_MODELS") {
        return false;
    }
    is_release_build()
}

fn is_release_build() -> bool {
    env::var("PROFILE").ok().as_deref() == Some("release")
}

/// True when an env var is set to a non-empty value other than `0`.
fn env_flag_enabled(name: &str) -> bool {
    env::var(name).is_ok_and(|value| !value.trim().is_empty() && value.trim() != "0")
}

fn swift_target_triple(deployment_target: &str) -> String {
    let arch = match env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_default()
        .as_str()
    {
        "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    };
    format!("{arch}-apple-macosx{deployment_target}")
}

fn swift_deployment_target() -> String {
    let requested = env::var("MACOSX_DEPLOYMENT_TARGET")
        .ok()
        .filter(|version| !version.trim().is_empty())
        .unwrap_or_else(|| "13.0".to_string());

    if compare_macos_versions(&requested, MIN_SWIFT_DEPLOYMENT_TARGET) == Some(Ordering::Less) {
        MIN_SWIFT_DEPLOYMENT_TARGET.to_string()
    } else {
        requested
    }
}

fn compare_macos_versions(left: &str, right: &str) -> Option<Ordering> {
    let left = parse_macos_version(left)?;
    let right = parse_macos_version(right)?;
    let length = left.len().max(right.len());

    for index in 0..length {
        let left_part = left.get(index).copied().unwrap_or_default();
        let right_part = right.get(index).copied().unwrap_or_default();
        match left_part.cmp(&right_part) {
            Ordering::Equal => {}
            ordering => return Some(ordering),
        }
    }

    Some(Ordering::Equal)
}

fn parse_macos_version(version: &str) -> Option<Vec<u32>> {
    let parts = version
        .trim()
        .split('.')
        .map(str::parse)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;

    (!parts.is_empty()).then_some(parts)
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
