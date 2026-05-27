# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-05-27

### Fixed

- The language-server capability check now waits up to 5 minutes when the resolved binary is the Composer PHP launcher (`vendor/bin/mago-lsp`), which downloads the native binary on first run. Previously the 5-second timeout caused a false "no language-server support" error on cold installs.
- Status bar shows `downloading...` during the first-run binary download so the user knows activation is in progress.

## [0.9.0] - 2026-05-27

Initial release.

### Added

- LSP client that communicates with the Mago language server over the Language Server Protocol, providing real-time diagnostics, code formatting, hover, completion, inlay hints, and code lenses for PHP files.
- **Lazy binary download** — the Composer package (`clearlyip/mago-lsp`) ships a PHP launcher script (`vendor/bin/mago-lsp`) that downloads the native binary on first invocation and caches it locally. No binary is bundled in the package itself.
- `mago.executablePath` setting with automatic detection of `vendor/bin/mago-lsp` installed by the Composer package, falling back to `mago` on `PATH`.
- `mago.configPath`, `mago.workspace`, `mago.phpVersion`, `mago.threads`, `mago.allowUnsupportedPhpVersion`, `mago.noVersionCheck`, `mago.noAnalyzer`, `mago.noLinter`, `mago.noFormatter`, `mago.logLevel`, `mago.maxRestartCount`, `mago.hideStatusBarWhenIdle`, and `mago.trace.server` settings.
- Status bar item showing server state with spinner, check, error, and stop icons.
- Commands: `Mago: Restart Language Server`, `Mago: Stop Language Server`, `Mago: Show Output Channel`.
- Automatic server restart when `mago.toml` is created, modified, or deleted.
- Automatic server restart when the active editor switches to a different workspace folder.
- PHP file watchers scoped to the `[source] paths` declared in `mago.toml`; falls back to watching all PHP files when no paths are configured.
- Conflict detection — warns when another Mago extension (`Michael4d45.mago-vscode`, `kgz.mago-unofficial`) is active and would produce duplicate diagnostics.
- GitHub Actions workflow that builds LSP-enabled Mago binaries for Linux (x86\_64, aarch64, armv7 musl), macOS (x86\_64, aarch64), Windows (x86\_64), and FreeBSD (x86\_64) on every upstream Mago release.
- Dependabot configuration for weekly npm and monthly GitHub Actions updates.

### Fixed

- `activate()` removes any legacy hand-placed `mago-lsp` binary left by pre-release plugin versions before Composer processes bin entries, preventing a "name conflicts with an existing file" warning on upgrade.
