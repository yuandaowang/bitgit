# macOS and Linux build plan

Status (2026-10-29): 1.3.0 is prepared on `dev-ui-optimize` (board density and grid, labels,
search history, any Git remote including GitLab, a local-folder project, and a terminal from the
compact card). 1.2.0 and 1.2.1 are the published Windows, unsigned macOS and Linux AppImage
releases. The items under "Verification still needed" stay open until checked on a Mac or a Linux
desktop.

## Goal

BitGit installs and runs its full workflow on macOS and Linux with the same invariants as on
Windows: projects, Git, publishing, recovery, editor launch and the GitHub token.

## Decisions that constrain further changes

- macOS 11.0 minimum: Node.js 22 and the aarch64 target need it, and older versions cannot be
  tested on GitHub runners.
- Linux ships the AppImage only. `targets` lists `nsis, msi, app, dmg, appimage, updater`. The deb
  needs `libwebkit2gtk-4.0-37`, which Ubuntu 24.04 and Debian 13 lack; deb and rpm return with
  Tauri 2.
- macOS releases ship unsigned until the user adds the six secrets in
  [BUILD.md](../../BUILD.md#macos-and-linux) (user's decision, 2026-10-25). Without them
  `release.yml` signs the app ad hoc, because Apple Silicon calls an unsigned download damaged and
  offers no Open Anyway. It packages the DMG unsigned, because macOS 15 blocks an ad-hoc signed DMG
  (tauri-apps/tauri#12288), and checks only `codesign --verify`. With all six set, the Developer
  ID path (as Graal RC and Loom) signs, notarizes and checks `codesign`, `spctl` and `stapler`.
  With some set, the job fails. No Windows signing, no spend.
- macOS bundles carry only the service's runtime dependencies: the dev dependencies include
  esbuild's unsigned binary, which notarization rejects. A release adding a native dependency to
  `git-service` must sign it or keep it out of the bundle.
- Node.js stays a user prerequisite, found through the login-shell PATH. The code floor is 20;
  docs recommend 22 or 24.
- On macOS and Linux the service resolves physical paths at its boundary (`physicalPath`, see
  [recovery design](../RECOVERY_DESIGN.md#storage-and-capture)). Project config and receipts keep
  the user's spelling. Windows is unchanged, junction refusal included.
- Releases publish as prereleases: `releases/latest`, the updater feed, skips them until a person
  clears the flag.

## Open items

For the user, at publish time:
- Whether to annotate the 1.1.2 notes, whose deb no longer installs on current distributions.
- `softprops/action-gh-release@v1` runs on a retired Node version (actionlint); move to v2 before
  the first tagged release.
- Later, to sign: add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_KEY_CONTENT` to the repository, reusing the
  Developer ID and App Store Connect key that Graal RC and Loom use. Then drop the Open Anyway
  steps from the release notes and `INSTALL.md`.

Code and docs, not started:
- `AddProjectModal.tsx`, `LinkLocalModal.tsx`: placeholders that are not Windows paths.
- `src-tauri/src/commands.rs`: scrub AppImage variables (`APPDIR`, `GTK_*`, `GDK_*`) for editor
  launches, if a test shows them leaking.
- Known limit: when a symlinked project root's target is deleted, the dangling link's own path
  becomes the vault key, so that history shows only under the target's spelling until it returns.

## Later

Tauri 2 (webkit2gtk 4.1, current-distro deb and rpm; keep v1-compatible updater artifacts), a Node
sidecar, Linux arm64, a macOS universal binary, cgroup-scoped checks on Linux, Flatpak and Snap.

## Verification still needed

- `ci.yml` green on windows-2025, macos-15 (arm64) and ubuntu-22.04. The Unix-only tests run there
  first: physical paths, the status-fetch process-group kill, the Secret Service message. x64 macOS
  is cross-compiled only.
- First release run: the secrets check takes the unsigned path, `codesign --verify` passes on the
  ad-hoc app, the DMG uploads by release ID, `latest.json` lists both darwin platforms, the bundle
  smoke pong on macOS and Linux, the prerelease flag. The signed path (notarization with the
  pruned dependencies, `spctl`, `stapler`) first runs once the secrets exist.
- Hardened runtime without entitlements on a Mac: Keychain access, spawning `node` and the login
  shell, the webview.
- On a real Mac and a Linux desktop (or VMs):
  - Finder and menu launch with Node from nvm only finds node and git.
  - A second launch shows the "already running" dialog, shown before the event loop starts.
  - Token save, read and restart; on Linux, the Secret Service error without a keyring.
  - Each editor preset opens, including the macOS app-bundle fallback without the shell command.
  - On macOS 15 the downloaded DMG mounts without a prompt, the app is not called damaged, and
    Open Anyway opens it. After an in-app update, expect a new Keychain prompt: an ad-hoc
    signature's designated requirement is its cdhash (unverified).
  - The 1.1.2 to next-version update for `.app` and AppImage.
  - AppImage on Ubuntu 24.04 and Fedora, including Wayland, and the NVIDIA workaround in INSTALL.md.
  - A check timeout and a status-fetch timeout end their process groups.
  - Recovery save, compare, recover copy and repair on a real project, including one under a
    linked ancestor (Fedora Atomic's `/var/home`, macOS `/tmp`).

The `zznam/bitgit` fork's ungated credential test is taken (1fb1a3a). Leave out its `xattr -cr`
advice: it strips quarantine wholesale.
