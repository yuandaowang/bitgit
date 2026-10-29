# BitGit Build & Distribution Guide

This guide explains how to build the BitGit MSI installer for Windows distribution. macOS and Linux
builds are covered under [macOS and Linux](#macos-and-linux).

## Prerequisites

Before building, ensure you have:

- ✅ Windows 10/11 (x64)
- ✅ Node.js 20+ installed (22 or 24 recommended)
- ✅ Rust toolchain installed (https://rustup.rs/)
- ✅ Git for Windows installed
- ✅ PowerShell 5.1+ or PowerShell Core

## Quick Start

### Option 1: Using PowerShell (Recommended)

```powershell
# 1. Create code signing certificate (run as Administrator, FIRST TIME ONLY)
.\scripts\create-signing-cert.ps1

# 2. Build the MSI installer
.\scripts\build-msi.ps1
```

### Option 2: Using CMD/Batch

```cmd
REM 1. Create certificate (run PowerShell as Admin, FIRST TIME ONLY)
powershell -ExecutionPolicy Bypass -File .\scripts\create-signing-cert.ps1

REM 2. Build MSI
.\scripts\build-msi.cmd
```

### Option 3: Manual Build

```bash
# 1. Build git-service
cd git-service
npm install
npm run build
cd ..

# 2. Build frontend and Tauri app
npm install
npm run build
npm run tauri build
```

## macOS and Linux

Prerequisites: Node.js 20 or later (22 or 24 recommended), Git, and Rust at the `rust-version` in
`src-tauri/Cargo.toml`.

- **macOS 11 or later:** the Xcode Command Line Tools (`xcode-select --install`).
- **Linux:** build on Ubuntu 22.04 (or Debian 12), as the release does. Tauri 1 needs
  webkit2gtk 4.0, which Ubuntu 24.04 no longer ships:
  `sudo apt-get install libwebkit2gtk-4.0-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`

Build and test from the project root in bash:

```bash
npm ci
npm --prefix git-service ci
npm --prefix git-service run build
npm run tauri:build
node --test git-service/tests/*.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
```

Bundles land in `src-tauri/target/release/bundle/`: `macos/BitGit.app` and `dmg/` on macOS,
`appimage/` on Linux. `targets` in `tauri.conf.json` limits Linux to the AppImage.

Local builds are unsigned (`signingIdentity` is null). A Mac opens one built on that Mac; a copy
taken to another Mac needs **Open Anyway** under System Settings > Privacy & Security once.

Release builds come from `.github/workflows/release.yml`. The macOS build depends on six
repository secrets: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY` (key ID) and `APPLE_API_KEY_CONTENT`
(the .p8 text).

- All six set: the app is signed with the Developer ID and notarized, then checked with
  `codesign --verify`, `spctl --assess` and `stapler validate`.
- None set (1.2.0): the app is signed ad hoc and checked with `codesign --verify`; users approve
  the first launch with **Open Anyway**. The DMG is packaged unsigned and attached by a workflow
  step, because macOS 15 blocks an ad-hoc signed DMG.
- Only some set: the job fails.

Both paths then ping the Git service inside the macOS app, as the Linux job does inside the
AppImage (`scripts/bundle-smoke.mjs`). Releases are published as prereleases, which the updater
does not see until the prerelease flag is cleared.

## Code Signing Setup (First Time Only)

### Why Sign Your Application?

Code signing prevents Windows from automatically deleting/blocking your MSI installer. Without signing:
- ❌ Windows Defender may quarantine your installer
- ❌ SmartScreen will show aggressive warnings
- ❌ Users may not trust the installer

With self-signed certificate:
- ✅ Windows recognizes the publisher
- ✅ Defender won't auto-delete
- ⚠️ SmartScreen will still warn (requires EV cert to eliminate)

### Creating the Self-Signed Certificate

**Run as Administrator:**

```powershell
.\scripts\create-signing-cert.ps1
```

This script will:
1. Generate a 3-year self-signed code signing certificate
2. Install it to your certificate stores
3. Export a backup PFX file
4. Update `tauri.conf.json` with the certificate thumbprint

**Important Files Created:**
- `scripts/bitgit-signing-cert.pfx` - Certificate backup (keep safe!)
- `scripts/cert-thumbprint.txt` - Certificate identifier

**Certificate Password:** You will be prompted to enter a password when running the script

### Backup Your Certificate

⚠️ **CRITICAL:** Back up `scripts/bitgit-signing-cert.pfx` to a secure location!

If you lose this certificate:
- Users who installed previous versions will see trust warnings on updates
- You'll need to create a new certificate and redistribute

To restore certificate on another machine:
```powershell
# Import PFX (you'll be prompted for password)
Import-PfxCertificate -FilePath .\scripts\bitgit-signing-cert.pfx -CertStoreLocation Cert:\CurrentUser\My
```

## Building the MSI Installer

### Using the Build Script

```powershell
.\scripts\build-msi.ps1
```

The script will:
1. ✅ Check for code signing certificate
2. ✅ Build git-service (Node.js → JavaScript)
3. ✅ Build frontend (React → Production bundle)
4. ✅ Build Tauri app (Rust + bundle → MSI)
5. ✅ Sign the MSI with your certificate

**Build time:** 5-10 minutes (first build), 2-3 minutes (subsequent)

### Build Output

Your MSI installer will be located at:
```
src-tauri\target\release\bundle\msi\BitGit_0.1.0_x64_en-US.msi
```

**Typical file size:** 15-25 MB

### Opening the Output Folder

```powershell
explorer "src-tauri\target\release\bundle\msi"
```

## Distribution

### For End Users

**Installation Instructions:**

1. Download `BitGit_x.x.x_x64_en-US.msi`
2. Right-click the MSI → **Properties** → Check **Unblock** (if present) → **OK**
3. Double-click the MSI to install
4. If SmartScreen appears:
   - Click **"More info"**
   - Click **"Run anyway"**
5. Follow the installation wizard

**System Requirements:**
- Windows 10/11 (x64)
- Git for Windows must be installed
- Node.js 20+ must be installed (22 or 24 recommended)
- ~100MB disk space

### SmartScreen Warnings

**Expected behavior with self-signed certificate:**

```
Windows protected your PC
Microsoft Defender SmartScreen prevented an unrecognized app from starting.

Publisher: BitGit Developer
```

**Users should click:** "More info" → "Run anyway"

### Eliminating SmartScreen (Optional)

To completely remove SmartScreen warnings, you need an **Extended Validation (EV) Code Signing Certificate**:

**Pros:**
- ✅ No SmartScreen warnings
- ✅ Immediate trust from Windows
- ✅ Professional appearance

**Cons:**
- ❌ Costs $300-$500/year
- ❌ Requires business verification
- ❌ Requires physical USB token

**Recommended Vendors:**
- DigiCert (https://www.digicert.com/signing/code-signing-certificates)
- Sectigo (https://sectigo.com/ssl-certificates-tls/code-signing)
- GlobalSign (https://www.globalsign.com/en/code-signing-certificate)

To use a commercial certificate:
1. Purchase EV code signing certificate
2. Install it to your certificate store
3. Copy the thumbprint
4. Update `tauri.conf.json`:
   ```json
   "certificateThumbprint": "YOUR_THUMBPRINT_HERE"
   ```
5. Rebuild with `.\scripts\build-msi.ps1`

## Troubleshooting

### Error: "Certificate not found"

**Solution:** Run `.\scripts\create-signing-cert.ps1` as Administrator

### Error: "Node modules not found"

**Solution:** Run `npm install` in both project root and `git-service/`

### Error: "Rust compiler not found"

**Solution:** Install Rust from https://rustup.rs/

### MSI won't install: "Publisher could not be verified"

**Solution:** Right-click MSI → Properties → Check "Unblock" → OK

### Build fails with "cargo: command not found"

**Solution:**
1. Install Rust: https://rustup.rs/
2. Restart your terminal
3. Verify: `cargo --version`

### Git operations fail in production build

**Cause:** Git for Windows not installed on user's machine

**Solution:** Document Git for Windows as a prerequisite in your installer/docs

## Version Management

### Updating Version Number

Keep the same version in all five places. `git-service/package.json` stays at `0.1.0`.

- `package.json` and the two root `version` fields in `package-lock.json`
- `src-tauri/tauri.conf.json` (`package.version`)
- `src-tauri/Cargo.toml` and the `bitgit` package in `src-tauri/Cargo.lock`

The GitHub release text lives in `.github/workflows/release.yml` under **What's New**. Move the
previous version's bullets under `### In x.y.z` so they stay on the release page.

## Publishing installers on GitHub

`.github/workflows/release.yml` builds every platform when a `v*` tag is pushed. The app version
inside the installers comes from `tauri.conf.json`, so the tag must be that version with a `v`
prefix (`v1.3.0` for version `1.3.0`).

```bash
git tag v1.3.0
git push origin v1.3.0
```

The workflow then:

1. Opens a draft release named `BitGit 1.3.0` and writes the **What's New** text into it.
2. Builds in parallel:
   - **Windows** (`windows-2025`): NSIS setup (`BitGit_<version>_x64-setup.exe`) and MSI
     (`BitGit_<version>_x64_en-US.msi`)
   - **macOS** (`macos-15`, Apple Silicon runner): Apple Silicon and Intel, each as
     `BitGit_<version>_aarch64.dmg` or `BitGit_<version>_x64.dmg`, plus the updater archive.
     Intel is cross-compiled. With none of the six Apple secrets set, the app is signed ad hoc
     and the DMG is unsigned. With all six set, it is Developer ID signed and notarized.
   - **Linux** (`ubuntu-22.04`): `bit-git_<version>_amd64.AppImage` only
3. Attaches those files to the draft, then marks the release public and a **prerelease**.

`releases/latest`, which the in-app updater reads, skips prereleases. After you have checked the
assets, open the release on GitHub and clear **Set as a pre-release**. Re-running a failed job
replaces that job's assets on the same release.

`workflow_dispatch` is also listed, but the release name is taken from the tag. Trigger the
workflow by pushing `v*`, not from the Actions button on a branch.

Windows installers from this workflow are not code-signed. The self-signed certificate in
[Code Signing Setup](#code-signing-setup-first-time-only) exists only on a local machine. GitHub
Actions does not have it. Signing in CI means storing the PFX and its password as repository
secrets and importing them in the workflow; otherwise users see SmartScreen on first launch.

## Development vs Production

### Development Build

```bash
npm run tauri dev
```
- Fast hot-reload
- Dev tools enabled
- Not optimized
- No signing required

### Production Build

```bash
npm run tauri build
```
- Fully optimized
- Minified bundle
- Signed MSI
- Ready for distribution

## File Structure

```
BitGit/
├── scripts/
│   ├── create-signing-cert.ps1   # Certificate generator
│   ├── build-msi.ps1              # Build script
│   ├── build-msi.cmd              # CMD wrapper
│   ├── bitgit-signing-cert.pfx    # Certificate backup (gitignored)
│   └── cert-thumbprint.txt        # Certificate ID (gitignored)
├── src-tauri/
│   ├── tauri.conf.json            # Tauri configuration
│   └── target/release/bundle/msi/ # Build output
├── git-service/
│   ├── dist/                      # Compiled JS (bundled into MSI)
│   └── package.json
└── BUILD.md                       # This file
```

## Security Notes

1. **Never commit certificate files to Git:**
   - `*.pfx` files are excluded in `.gitignore`
   - Certificate thumbprints are safe to commit

2. **Certificate backup:**
   - Store `bitgit-signing-cert.pfx` in a secure backup location
   - Password protect the PFX file

3. **Commercial certificates:**
   - Store in hardware token (required for EV certs)
   - Never share private keys

## Support

For build issues:
- Check `src-tauri/target/release/bundle/msi/` for error logs
- Verify all prerequisites are installed
- Check that `git-service/dist/` contains compiled JS files
- Ensure certificate is properly installed (run `certmgr.msc`)

For distribution issues:
- Test MSI on a clean Windows VM before public release
- Document Git for Windows requirement clearly
- Provide SmartScreen bypass instructions to users
