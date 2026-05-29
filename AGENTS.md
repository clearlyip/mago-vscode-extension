# AGENTS.md

## Project Overview

Mago VS Code Extension is a VS Code extension that provides PHP linting, formatting, and static analysis via the Mago language server (LSP). The extension communicates with the Mago binary over the Language Server Protocol to provide real-time diagnostics, code formatting, hover information, completion, inlay hints, and code lenses for PHP files.

### Architecture

- **TypeScript** — Extension code under `src/`, bundled to `dist/extension.js` via esbuild
- **vscode-languageclient** — LSP client library that handles protocol communication with the Mago server
- **PHP Composer plugin** — `plugin/` contains a Composer plugin (`clearlyip/mago-lsp`) that auto-installs the Mago binary with LSP support into `vendor/bin/mago-lsp`

### Key Source Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point — activates extension, wires up server, commands, status bar, conflict detection |
| `src/LanguageServer.ts` | LSP client lifecycle — resolves binary path, validates LSP support, starts/stops/restarts server |
| `src/StatusBar.ts` | VS Code status bar item showing server status with icons |
| `src/LoggingService.ts` | Output channel with log levels, used by both extension and LSP client |
| `src/commands.ts` | Registers `mago.restartServer`, `mago.stopServer`, `mago.showOutputChannel` |
| `esbuild.js` | Build script — bundles `src/extension.ts` to `dist/extension.js` |
| `plugin/src/` | Composer plugin that downloads Mago binary on `composer install/update` |

## Setup Commands

```bash
# Install dependencies
npm install

# Development build (unminified, with source maps)
npm run compile

# Watch mode for development
npm run watch

# Production build (minified, no source maps)
npm run package

# Type-check and lint
npm run check
```

## Development Workflow

### Building

- **`npm run compile`** — Development build with source maps. Output: `dist/extension.js`
- **`npm run watch`** — Watch mode, rebuilds on file changes
- **`npm run package`** — Production build (minified, no source maps)
- **`npm run check`** — Runs `tsc --noEmit` and `biome check` (type-check + lint)

### Debugging in VS Code

Use the launch configurations in `.vscode/launch.json`:

1. **"Run Extension"** — Compiles then launches VS Code with the extension loaded
2. **"Run Extension (watch)"** — Starts watch mode then launches VS Code
3. **"Extension Tests"** — Runs extension test suite

To debug:
1. Run `npm run compile` or use the "Run Extension" launch config (it has a `preLaunchTask`)
2. Open the Run and Debug view, select "Run Extension"
3. A new VS Code window opens with the extension loaded from `dist/`
4. Open a PHP file in the new window to activate the extension

### Extension Packaging

To create a `.vsix` file for distribution:

```bash
npm run package
npx vsce package
```

The `.vscodeignore` file excludes source files, dev dependencies, and config from the package. Only `dist/extension.js`, `package.json`, and `LICENSE` are included.

## Testing Instructions

```bash
# Run extension tests
npm test
```

Tests use the `@vscode/test-cli` framework. Test files go under `src/test/` and are compiled to `dist/test/`. The test entry point is `dist/test/suite/index`.

## Code Style

### TypeScript

- **Strict mode** enabled (`tsconfig.json`)
- `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` all enforced
- Target: ES2022, Module: Node16
- Source root: `src/`

### Biome (linting and formatting)

- **Formatter**: 4-space indent, 120 char line width, single quotes, trailing commas, semicolons
- **Linter**: recommended rules + `noExplicitAny` (warn) + `noNonNullAssertion` (warn)
- Files: `src/**/*.ts` and `esbuild.js`

```bash
# Check formatting and linting
npm run check

# Run linter only
npm run lint

# Auto-format
npm run format
```

### Naming Conventions

- PascalCase for classes and types
- camelCase for functions, variables, and properties
- Files use PascalCase matching their exported class (e.g. `LanguageServer.ts`)
- Entry point is `extension.ts` (lowercase, per VS Code convention)

### Import Patterns

- Node built-ins use `node:` prefix (e.g. `import * as fs from 'node:fs'`)
- Relative imports for local modules (e.g. `import { LanguageServer } from './LanguageServer'`)
- vscode and vscode-languageclient imported as external dependencies

## Build and Deployment

### Build Pipeline

```
npm run check    # type-check + lint
npm run package  # production bundle
```

The `vscode:prepublish` script runs both before publishing to ensure quality.

### Publishing

```bash
# Publish to VS Code Marketplace
npx vsce publish

# Publish to Open VSX Registry
npx ovsx publish
```

### Version Management

Version is set in `package.json`. Bump version before publishing.

## VS Code Extension API Conventions

- Extension activates on `onLanguage:php` — only when a PHP file is open
- `vscode` module is external (provided by VS Code runtime, not bundled)
- All disposables are registered to `extensionContext.subscriptions` for cleanup
- Settings use `mago.` namespace, read via `vscode.workspace.getConfiguration('mago')`
- Output channel named "Mago" for all logging

## Configuration Settings

The extension exposes these settings (defined in `package.json.contributes.configuration`):

| Setting | Type | Default | Scope |
|---------|------|---------|-------|
| `mago.executablePath` | string | `"mago"` | machine-overridable |
| `mago.configPath` | string | `""` | resource |
| `mago.noAnalyzer` | boolean | `false` | resource |
| `mago.noLinter` | boolean | `false` | resource |
| `mago.noFormatter` | boolean | `false` | resource |
| `mago.logLevel` | string | `"info"` | window |
| `mago.maxRestartCount` | number | `5` | window |
| `mago.hideStatusBarWhenRunning` | boolean | `false` | window |
| `mago.disableFileFilter` | boolean | `false` | window |
| `mago.trace.server` | string | `"off"` | window |

## Additional Notes

- The Mago LSP is an **unstable preview** — wire protocol and capabilities may change without notice
- Extension detects conflicting Mago extensions at activation and warns the user
- Server auto-restarts when `mago.toml` changes or when switching workspace folders
- Binary resolution order: absolute path > `vendor/bin/mago-lsp` (Composer) > workspace-relative > PATH lookup
