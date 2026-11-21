# CI and signed releases

CI runs on PRs and pushes to `main`. It runs `npm run verify:release`,
builds both Linux remote CLIs, and uploads a development DMG for seven
days. PR, main, and manual builds all target Apple
Silicon. Development apps are ad-hoc-signed; their DMGs are
unsigned. Development builds disable updater artifacts and never
receive signing secrets. CI verifies the app and the app inside the
mounted DMG, including their ARM-only architecture and both Linux
remote helpers.

The separate **Signed release** workflow checks every push to `main`
in `raykyri/qmux`. When `package.json`'s version increases compared
with the start of that push, it automatically tests, builds, signs,
notarizes, verifies, and creates a **draft** release. Dependency
edits, unchanged versions, and version decreases skip the signed build
before entering the `release` environment. You can also run the workflow
manually from `main`. After testing the installation, publish the draft
manually; pushing a version bump does not publish it.

## 1. Enable Actions and protect main

In `raykyri/qmux` → **Settings → Actions → General**:

- Enable GitHub Actions. If actions are allowlisted, allow
  `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
  and `mlugg/setup-zig`. Workflow action references are pinned to
  full commit hashes.
- The default workflow token can remain read-only. The release job
  explicitly requests `contents: write`; repository/organization
  policy must permit it. No personal access token or permission to
  create PRs is needed.
- Keep fork PR workflows from receiving secrets or write tokens.

After the first CI run, add **macOS checks and build** as a required
status check in the `main` branch ruleset. Require reviewed PRs if that
matches your repository policy. The CI workflow has no path filters,
so a required check will also run for
documentation changes.

The pinned build setup is in `.github/actions/setup-build/action.yml`:
Node 22.22.3, Rust 1.95.0, Zig 0.15.2, cargo-zigbuild 0.23.4, and
Xcode 26.3 on `macos-15`. Xcode is selected explicitly because
Foundation Models needs the newer SDK and native tests need full
Xcode. If GitHub retires that Xcode version, update the shared setup
and check that CI passes before the next release. The shared setup
requires an ARM64 host for native tests. Only `aarch64-apple-darwin`
is supported for the app; both Linux musl helper targets are supported.
Local `npm run build` uses the same ARM target, and `npm run build:aarch`
is a compatibility alias. Intel and universal
target overrides are rejected before build or release work.

## 2. Create the release environment

Open **Settings → Environments → New environment**, named exactly
`release`.

- Under deployment branches and tags, choose **Selected branches and
  tags**, and add a **branch** rule for exactly `main`. Do not add a
  wildcard or tag rule.
- Optionally add a required reviewer when your GitHub plan supports
  it. For a solo maintainer, do not enable “prevent self-review”
  unless someone else can approve the run.
- Put the following secrets and variables on this environment, not in
  `.env` or workflow YAML.

Available environment protection rules depend on repository visibility
and plan: [GitHub environment
documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## 3. Add environment secrets

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 encoding of your Developer ID Application `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Nonempty password chosen when exporting that `.p12` |
| `APPLE_ID` | Apple account email used for notarization |
| `APPLE_PASSWORD` | Apple **app-specific password**, not your normal login password |
| `APPLE_TEAM_ID` | Apple Developer team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the existing qmux updater private-key file, not a local path |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key passphrase, if encrypted; omit this secret for an unencrypted key |

To set up the Apple signing certificate:

1. Use an active Apple Developer Program account and a **Developer ID
   Application** certificate for distribution outside the App Store.
2. In Keychain Access → login → My Certificates, locate that identity
   and confirm it has a private key. Export the certificate and
   private key together as a password-protected `.p12`. A downloaded
   `.cer` does not include the private key.
3. Upload the base64 encoding as `APPLE_CERTIFICATE`. For example,
   from your own terminal after `gh auth login`:

   ```sh
   base64 -i /path/to/qmux-developer-id.p12 |
     gh secret set APPLE_CERTIFICATE --env release --repo raykyri/qmux
   ```

4. Create an app-specific password at [Apple
   Account](https://account.apple.com/) → Sign-In and Security →
   App-Specific Passwords, and save it as `APPLE_PASSWORD`.

Use the **existing** updater key corresponding to
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Do not
generate a new key for CI: already-installed apps trust the existing
public key. Back up the private key securely.

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo raykyri/qmux \
  < "$HOME/.tauri/qmux-updater.key"
```

Set the other secrets through the environment UI or `gh secret set
NAME --env release --repo raykyri/qmux`, which prompts for the
value. Do not put secret values in command arguments, commit them, or
paste them into chat.

The workflow generates a temporary keychain password. You do not need
`KEYCHAIN_PASSWORD`, `GH_TOKEN`, `GITHUB_TOKEN`, or a
provisioning-profile secret. It supplies GitHub's automatic token to
`gh` and removes its temporary keychain and `.p12` even after failure.

This workflow uses Apple ID notarization. The local scripts also
support API keys, but adding API-key secrets alone will not switch
this workflow to that authentication method.

References: [Tauri
signing](https://v2.tauri.app/distribute/sign/macos/), [GitHub
certificate
import](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications),
[Tauri updater keys](https://v2.tauri.app/plugin/updater/).

## 4. Add environment variables

| Variable | Value |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Exact identity name, such as `Developer ID Application: Your Name (TEAMID)` |
| `QMUX_GITHUB_CLIENT_ID` | Client ID of the GitHub OAuth app used by qmux's publishing device flow |

Find the identity name with:

```sh
security find-identity -v -p codesigning
```

Copy the name inside the quotation marks, not the hash or quotation
marks. The team should match `APPLE_TEAM_ID`.

Reuse your existing publishing OAuth app's client ID. If creating one,
visit GitHub → Settings → Developer settings → OAuth Apps, and enable
Device Flow. This public client ID is included in the app; no OAuth
client secret is used. The release workflow requires it because
publishing is disabled without it.

## 5. Run CI, then create the first draft

1. Commit and push/merge the workflow changes to `main`. Manual
   workflows must be present on the default branch to appear in the
   Actions UI.
2. Let **CI** pass. Its downloadable DMG is a development artifact,
   not the signed release.
3. Increase the release version in `package.json`,
   `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; keep the
   npm and Cargo lockfiles in sync when bumping versions. Commit and
   push/merge the version bump to `main` to start **Signed release**
   automatically. The version's `vX.Y.Z` tag must not already
   exist. Do not create the tag yourself. The first Apple
   Silicon-only release must use a new version after v0.4.0; do not
   replace the existing universal release or any of its assets.
4. Open **Actions → Signed release** to follow the automatic run. The
   run must wait for any configured environment timer or required review.
   To retry manually, use **Run workflow**, selecting `main`. An initial
   branch push without a previous commit requires a manual run because
   there is no version to compare.
5. The script requires the selected commit to still match
   `origin/main`. If main moved while the run was queued, start a
   fresh run.
6. On success, open Releases and inspect the draft. Expect:
   `qmux_X.Y.Z_aarch64.dmg`, `qmux.app.tar.gz`, `qmux.app.tar.gz.sig`,
   `latest.json`, and `SHA256SUMS`.

Before uploading, the release script checks that the built app, updater
archive, and app inside the mounted DMG contain only `arm64`. Packaged
executables must match the built app, and all three copies must
include both executable Linux remote CLIs. It also checks app and DMG
signatures, stapled app notarization tickets, and Gatekeeper
acceptance. Tauri notarizes the app and staples its notarization ticket.
The DMG is signed and contains that app. The workflow does not check for a separate
notarization ticket on the DMG. Local releases using
`QMUX_ALLOW_UNNOTARIZED=1` still verify signatures, architectures,
helpers, and packaged executables; only notarization and Gatekeeper
checks are skipped.

Download the draft DMG in a browser and install it on Apple
Silicon. Check terminal rendering, app shortcuts while the terminal is
focused, plugins, remote CLI installation on both Linux architectures,
and publishing. Test the updater with a controlled endpoint before
publication; the normal public updater endpoint cannot serve a private
draft. Confirm a native ARM client can update and an older Intel
client is not offered the ARM archive.

`latest.json` must contain only `darwin-aarch64`; never point
`darwin-x86_64` at the ARM archive. The current updater logs a
missing-platform error and continues normal startup on Intel. Existing
universal apps running under Rosetta also select the Intel updater
key, so Apple Silicon users in that situation should install the
native app manually to resume updates.

The generated release notes start with an Apple Silicon requirement and
a link to [v0.4.0, the final universal
release](https://github.com/raykyri/qmux/releases/tag/v0.4.0). Check this
notice in the draft. Preserve all historical universal releases and
their assets for Intel users.

Publish the draft only after these checks. The app's updater is
configured for `raykyri/qmux/releases/latest/download/latest.json`;
use a normal stable release for that channel. Do not move releases to
the private remote without also redesigning updater access.

## Failures and reruns

- **Missing setting:** add it to the `release` environment using the
  exact name above. The workflow checks required settings before
  installing the toolchain.
- **Signing identity unavailable:** re-export the `.p12` with its
  private key, verify its password, and check the identity variable
  exactly matches.
- **Notarization failure:** verify the account, app-specific password,
  team membership, and Apple Developer agreements; inspect the Tauri
  error. CI does not allow unnotarized releases.
- **Upload failure:** inspect the Releases page and tags before
  retrying. A partial draft or tag may already exist. The script
  rejects existing tags to avoid overwriting releases. Remove only a
  confirmed unpublished failed draft or tag, or use a new version; never delete a published release to make a rerun
  pass.
- **Toolchain/runner changes:** update the shared setup used by both CI
  and signed builds.

Linting these files does not test hosted builds or Apple notarization.
Verify both with the first CI run and first signed draft.
