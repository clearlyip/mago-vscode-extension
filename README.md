<div align="center">
  <img src="https://raw.githubusercontent.com/clearlyip/mago-vscode-extension/refs/heads/master/docs/static/img/banner.png" alt="Mago Banner" width="480" />
</div>

<div align="center">

# Mago LSP

[![VS Code Marketplace](https://img.shields.io/badge/VS_Code_Marketplace-Mago_LSP-blue?style=flat-square&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Clearlyip.mago-vscode-extension)
[![VS Code Version](https://img.shields.io/badge/VS_Code-%3E%3D1.85.0-blue?style=flat-square&logo=visualstudiocode)](https://code.visualstudio.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

VS Code extension for PHP linting, formatting, and static analysis powered by the [Mago](https://github.com/carthage-software/mago) language server.

[Prerequisites](#prerequisites) • [Installation](#installation) • [Configuration](#configuration) • [Commands](#commands) • [Troubleshooting](#troubleshooting)

</div>

## Overview

**Mago LSP** integrates [Mago](https://mago.carthage.software) — a high-performance PHP linter, formatter, and static analyzer written in Rust — into Visual Studio Code via the Language Server Protocol. It provides real-time diagnostics, code formatting, hover information, completion, inlay hints, and code lenses for PHP files.

## Why This Extension

Several unofficial Mago extensions exist on the VS Code Marketplace. This extension is different because it communicates with Mago via the **official Language Server Protocol** rather than spawning the Mago CLI binary on every operation.

|                           | This Extension (LSP)                        | Unofficial Extensions (CLI)                  |
| ------------------------- | ------------------------------------------- | -------------------------------------------- |
| **Server model**          | Persistent language server process          | Spawns `mago` binary per file save / command |
| **Startup cost**          | One-time on activation                      | Every save, every command                    |
| **Real-time diagnostics** | Incremental, as-you-type                    | On save (or manual trigger)                  |
| **LSP features**          | Hover, completion, inlay hints, code lenses | Diagnostics only                             |
| **Analysis state**        | Persistent across edits                     | Fresh process, no state reuse                |

Many other extensions work by invoking the Mago CLI for each lint, analyze, or format operation. This means the binary must start up, parse the file, and shut down repeatedly. The LSP approach keeps a single server process running that maintains analysis state and responds incrementally to edits, resulting in lower latency and richer editor integration.

## Prerequisites

The language server is an **unstable preview** in Mago and is **not included in default builds**. It must be explicitly enabled with the `language-server` Cargo feature.

> [!WARNING]
> The LSP implementation, advertised capabilities, CLI flags, and wire protocol may change without notice before Mago 2.0. There are no compatibility guarantees until that release.

### Option A — Composer package (recommended)

```sh
composer require clearlyip/mago-lsp
```

This installs a pre-built `mago` binary with LSP support into `vendor/bin/mago-lsp`. The extension detects it automatically.

### Option B — Pre-built binaries

This repository builds LSP-enabled binaries for every new upstream Mago release. Download the appropriate archive from the [releases page](https://github.com/clearlyip/mago-vscode-extension/releases), extract the `mago` binary, and set `mago.executablePath` to its location.

### Option C — Build from source

```sh
cargo install mago --features language-server
```

## Installation

Install from the VS Code Marketplace, or from a local `.vsix` file:

```sh
code --install-extension mago-0.1.0.vsix
```

## Configuration

All settings are under the `mago` namespace in VS Code settings.

| Setting                            | Default   | Scope    | Description                                                                                                                                                                                              |
| ---------------------------------- | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mago.executablePath`              | `"mago"`  | machine  | Path to the Mago binary. Accepts an absolute path, a workspace-relative path (e.g. `./bin/mago`), or a name on `PATH`. When left at default, the extension first checks for `vendor/bin/mago-lsp` (Composer), then falls back to `mago` on `PATH`. |
| `mago.configPath`                  | `""`      | resource | Path to `mago.toml`. If empty, Mago searches the workspace root.                                                                                                                                        |
| `mago.workspace`                   | `""`      | resource | Path to the workspace directory passed to the language server. Overrides the VS Code workspace root.                                                                                                     |
| `mago.phpVersion`                  | `""`      | resource | PHP version for parsing and analysis, e.g. `"8.3"`. Uses Mago's default when empty.                                                                                                                    |
| `mago.threads`                     | _(unset)_ | window   | Number of threads for linting, formatting, and analysis. Uses Mago's default when unset.                                                                                                                 |
| `mago.allowUnsupportedPhpVersion`  | `false`   | resource | Allow using an unsupported PHP version without an error.                                                                                                                                                 |
| `mago.noVersionCheck`              | `false`   | window   | Silence the project version drift warning.                                                                                                                                                               |
| `mago.noAnalyzer`                  | `false`   | resource | Disable the static analyzer. Hover types, completion, inlay hints, and code lenses will be degraded or unavailable.                                                                                     |
| `mago.noLinter`                    | `false`   | resource | Disable the linter. No lint diagnostics or quick-fix code actions.                                                                                                                                      |
| `mago.noFormatter`                 | `false`   | resource | Disable the formatter. Format Document will be unavailable for PHP files.                                                                                                                                |
| `mago.logLevel`                    | `"info"`  | window   | Output channel verbosity: `error`, `warn`, `info`, `debug`, or `trace`.                                                                                                                                 |
| `mago.maxRestartCount`             | `5`       | window   | Maximum automatic restarts after a server crash before giving up.                                                                                                                                        |
| `mago.hideStatusBarWhenIdle`       | `false`   | window   | Hide the status bar item when the server is idle.                                                                                                                                                        |
| `mago.trace.server`                | `"off"`   | window   | Trace LSP communication between VS Code and the server: `off`, `messages`, or `verbose`.                                                                                                                 |

## Commands

| Command                           | Description                                                   |
| --------------------------------- | ------------------------------------------------------------- |
| **Mago: Restart Language Server** | Stop and restart the server (picks up configuration changes). |
| **Mago: Stop Language Server**    | Stop the server without restarting.                           |
| **Mago: Show Output Channel**     | Open the Mago output panel for logs and diagnostics.          |

## Automatic restarts

The extension watches `mago.toml` across the workspace and restarts the server whenever the file is created, modified, or deleted. It also restarts when you switch to a file in a different workspace folder.

## Conflict detection

If another Mago-related extension is active (e.g. `Michael4d45.mago-vscode` or `kgz.mago-unofficial`), this extension will warn you about potential duplicate diagnostics and offer to open the Extensions view.

## Troubleshooting

**"Mago executable not found"**
Ensure `mago` is on your `PATH`, or set `mago.executablePath` to the full path of the binary. Verify it was built with LSP support:

```sh
mago language-server --help
```

If the subcommand is missing, reinstall with `cargo install mago --features language-server` or `composer require clearlyip/mago-lsp`.

**Server crashes immediately or produces no diagnostics**
Open the output channel (**Mago: Show Output Channel**) and set `mago.logLevel` to `debug` or `trace`. Validate your config with `mago config` in the workspace root.

**Duplicate diagnostics**
Another extension may be running Mago in parallel. Check the conflict warning at activation and disable the conflicting extension.

## Building the extension

```sh
npm install
npm run compile       # development build
npm run check         # type-check and lint
npm run package       # production bundle
```
