# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.5] - 2026-05-29

### Added

- `mago.hideStatusBarWhenRunning` — hide the status bar item when the server is running normally, for a less cluttered status bar.
- `mago.disableFileFilter` — opt-in setting to disable client-side filtering of PHP file notifications. When enabled, all PHP files are forwarded to the language server regardless of `source.paths` / `source.excludes` in `mago.toml`, restoring Mago's default behaviour.

### Fixed

- Status bar is now hidden (instead of showing "Mago: starting") in workspaces that have no `mago.toml` and no explicit `mago.configPath`. The status bar only appears when the server actually starts or encounters an error.

## [0.9.4] - 2026-05-28

### Fixed

- "Mago extension activated" is no longer logged when the language server did not start (e.g. missing `mago.toml`, executable not found, or binary lacking language-server support).
- The config file watcher now respects `mago.configPath`: when the setting is configured, only that specific file is watched for changes that trigger a server restart, rather than any `mago.toml` anywhere in the workspace.

## [0.9.3] - 2026-05-28

### Changed

- `mago.executablePath` default changed from `"mago"` to `""` (empty). When unset the extension still auto-detects `vendor/bin/mago-lsp` and falls back to `mago` on PATH, but the empty default makes it clearer that the user has not explicitly configured a path.
- When the default executable is not found, the failure is now logged at info level with no popup or error status — mago simply may not be installed in that project. A popup with "Open Settings" is still shown when an explicit `mago.executablePath` is set but does not resolve.
- `mago.threads` type widened to `["number", "null"]` so VS Code no longer shows a "value must be a number" validation error when the field is left empty.
- When `mago.executablePath` is not set and no `mago.toml` is found, the status bar is left untouched. The "no mago.toml" status is only shown when the user has explicitly configured an executable path, indicating deliberate Mago usage in that workspace.

## [0.9.2] - 2026-05-27

### Added

- The language server no longer starts in workspaces that have no `mago.toml` — this prevents a spurious "executable not found" popup when opening PHP files in projects that don't use Mago.
- If `mago.configPath` is set but the file does not exist, the server aborts with an error message and an "Open Settings" shortcut rather than silently failing.
- If `mago.workspace` is set but the path does not exist, the server aborts with an error message and an "Open Settings" shortcut.

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
- GitHub Actions workflow that builds LSP-enabled Mago binaries for Linux (x86_64, aarch64, armv7 musl), macOS (x86_64, aarch64), Windows (x86_64), and FreeBSD (x86_64) on every upstream Mago release.
- Dependabot configuration for weekly npm and monthly GitHub Actions updates.

### Fixed

- `activate()` removes any legacy hand-placed `mago-lsp` binary left by pre-release plugin versions before Composer processes bin entries, preventing a "name conflicts with an existing file" warning on upgrade.
