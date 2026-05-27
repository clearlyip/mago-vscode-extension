import { type ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    CloseAction,
    type CloseHandlerResult,
    ErrorAction,
    type ErrorHandler,
    type ErrorHandlerResult,
    LanguageClient,
    type LanguageClientOptions,
    type Message,
    RevealOutputChannelOn,
    type ServerOptions,
} from 'vscode-languageclient/node';

import type { LoggingService } from './LoggingService';
import { ServerStatus, type StatusBar } from './StatusBar';

// Candidates checked in order when executablePath is the default "mago".
// vendor/bin/mago-lsp is installed by the clearlyip/mago-lsp Composer package.
const VENDOR_CANDIDATES = ['vendor/bin/mago-lsp', 'vendor/bin/mago-lsp.exe'];

function parseTomlStringArray(content: string, section: string, key: string): string[] {
    const sectionMatch = content.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
    if (!sectionMatch) return [];
    const arrayMatch = sectionMatch[1].match(new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`));
    if (!arrayMatch) return [];
    return [...arrayMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

async function readMagoSourceConfig(configFilePath: string): Promise<{ paths: string[]; excludes: string[] }> {
    try {
        const content = await fs.promises.readFile(configFilePath, 'utf-8');
        return {
            paths: parseTomlStringArray(content, 'source', 'paths'),
            excludes: parseTomlStringArray(content, 'source', 'excludes'),
        };
    } catch {
        return { paths: [], excludes: [] };
    }
}

function resolveMagoPath(configured: string, workspacePath: string): string {
    if (path.isAbsolute(configured)) {
        return configured;
    }

    // Auto-detect the Composer-installed LSP binary when the user hasn't
    // overridden the default executable name.
    if (configured === 'mago') {
        for (const candidate of VENDOR_CANDIDATES) {
            const vendorPath = path.join(workspacePath, candidate);
            if (fs.existsSync(vendorPath)) {
                return vendorPath;
            }
        }
    }

    // Allow explicit workspace-relative paths like "./bin/mago-lsp"
    const local = path.join(workspacePath, configured);
    if (fs.existsSync(local)) {
        return local;
    }

    return configured;
}

function isMagoExecutable(execPath: string): boolean {
    try {
        fs.accessSync(execPath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Returns true when the binary at `execPath` was compiled with the
 * `language-server` feature, i.e. `mago --help` lists `language-server`
 * as an available subcommand.
 *
 * A binary built without `--features language-server` simply omits the
 * subcommand from its help output, so this is the canonical pre-flight check.
 * Times out after 5 s to avoid blocking activation indefinitely.
 */
function hasLanguageServerSupport(execPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(
            execPath,
            ['--help'],
            { timeout: 5000, env: { ...process.env, NO_COLOR: '1' } },
            (_err, stdout, stderr) => {
                // mago prints help to stdout; some versions may use stderr
                resolve((stdout + stderr).includes('language-server'));
            },
        );
    });
}

class MagoErrorHandler implements ErrorHandler {
    private restartCount = 0;

    constructor(
        private readonly maxRestarts: number,
        private readonly logger: LoggingService,
        private readonly statusBar: StatusBar,
    ) {}

    error(_error: Error, _message: Message | undefined, count: number): ErrorHandlerResult {
        this.logger.logError(`Language server error (${count})`);
        if (count < 3) {
            return { action: ErrorAction.Continue };
        }
        return { action: ErrorAction.Shutdown };
    }

    closed(): CloseHandlerResult {
        this.restartCount++;
        if (this.restartCount <= this.maxRestarts) {
            this.logger.logWarn(`Language server closed, restarting (${this.restartCount}/${this.maxRestarts})`);
            this.statusBar.update(ServerStatus.Initializing, 'restarting');
            return { action: CloseAction.Restart };
        }
        this.logger.logError('Language server exceeded max restarts, giving up');
        this.statusBar.update(ServerStatus.Error, 'stopped');
        return { action: CloseAction.DoNotRestart };
    }
}

export class LanguageServer {
    private client: LanguageClient | null = null;
    private workspacePath: string;
    private starting = false;

    constructor(
        workspacePath: string,
        private readonly statusBar: StatusBar,
        private readonly logger: LoggingService,
    ) {
        this.workspacePath = workspacePath;
    }

    getWorkspacePath(): string {
        return this.workspacePath;
    }

    setWorkspacePath(p: string): void {
        this.workspacePath = p;
    }

    isStarting(): boolean {
        return this.starting;
    }

    async start(): Promise<void> {
        const config = vscode.workspace.getConfiguration('mago');
        const rawExec = config.get<string>('executablePath') || 'mago';
        const execPath = resolveMagoPath(rawExec, this.workspacePath);

        if (!isMagoExecutable(execPath)) {
            const msg = `Mago executable not found or not executable at: ${execPath}\nSet mago.executablePath to the correct path.`;
            this.logger.logError(msg);
            this.statusBar.update(ServerStatus.Error, 'not found');
            vscode.window.showErrorMessage(`Mago: ${msg}`, 'Open Settings').then((action) => {
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'mago.executablePath');
                }
            });
            return;
        }

        if (!(await hasLanguageServerSupport(execPath))) {
            const msg =
                `The mago binary at "${execPath}" does not support the language-server subcommand. ` +
                `It must be compiled with --features language-server.\n\n` +
                `Install the LSP-enabled binary via Composer:\n` +
                `  composer require clearlyip/mago-lsp\n\n` +
                `Or build from source:\n` +
                `  cargo install mago --features language-server`;
            this.logger.logError(msg);
            this.statusBar.update(ServerStatus.Error, 'no language-server');
            vscode.window
                .showErrorMessage(`Mago: binary missing language-server support`, 'How to install', 'Open Settings')
                .then((action) => {
                    if (action === 'How to install') {
                        vscode.env.openExternal(
                            vscode.Uri.parse('https://github.com/clearlyip/mago-vscode-extension#prerequisites'),
                        );
                    } else if (action === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'mago.executablePath');
                    }
                });
            return;
        }

        const configuredWorkspace = config.get<string>('workspace');
        const cwd = configuredWorkspace ? path.resolve(this.workspacePath, configuredWorkspace) : this.workspacePath;
        const args = this.buildServerArgs(config, cwd);
        this.logger.logInfo(`Starting mago language server: ${execPath} ${args.join(' ')}`);
        this.logger.logInfo(`Server working directory: ${cwd}`);

        const serverOptions: ServerOptions = () => this.spawnServer(execPath, args, cwd);

        const maxRestarts = config.get<number>('maxRestartCount') ?? 5;
        const errorHandler = new MagoErrorHandler(maxRestarts, this.logger, this.statusBar);

        const clientWorkspaceFolder: vscode.WorkspaceFolder | undefined = configuredWorkspace
            ? { uri: vscode.Uri.file(cwd), name: path.basename(cwd), index: 0 }
            : undefined;

        const watchBase = clientWorkspaceFolder?.uri ?? vscode.Uri.file(this.workspacePath);

        const explicitConfigPath = config.get<string>('configPath');
        const resolvedConfigPath = explicitConfigPath
            ? path.resolve(cwd, explicitConfigPath)
            : path.join(cwd, 'mago.toml');
        const { paths: sourcePaths, excludes: sourceExcludes } = await readMagoSourceConfig(resolvedConfigPath);

        // Filter paths that are wholly covered by an exclude entry, then build one watcher per path.
        // VS Code watchers have no negation support, so partial sub-path exclusions are handled server-side by Mago.
        const activePaths =
            sourcePaths.length > 0
                ? sourcePaths.filter((p) => !sourceExcludes.some((ex) => p === ex || p.startsWith(ex)))
                : [];
        const phpWatchers =
            activePaths.length > 0
                ? activePaths.map((p) =>
                      vscode.workspace.createFileSystemWatcher(
                          new vscode.RelativePattern(watchBase, `${p.replace(/\/$/, '')}/**/*.php`),
                      ),
                  )
                : [vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(watchBase, '**/*.php'))];

        this.logger.logInfo(
            activePaths.length > 0
                ? `Watching PHP files in: ${activePaths.join(', ')}`
                : 'Watching all PHP files in workspace',
        );

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ scheme: 'file', language: 'php' }],
            workspaceFolder: clientWorkspaceFolder,
            synchronize: {
                fileEvents: [
                    ...phpWatchers,
                    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(watchBase, '**/mago.toml')),
                    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(watchBase, '**/composer.json')),
                ],
            },
            outputChannel: this.logger,
            traceOutputChannel: this.logger,
            revealOutputChannelOn: RevealOutputChannelOn.Error,
            progressOnInitialization: true,
            errorHandler,
            initializationOptions: {
                configPath: config.get<string>('configPath') || undefined,
            },
        };

        this.client = new LanguageClient('mago', 'Mago Language Server', serverOptions, clientOptions);

        this.starting = true;
        this.statusBar.update(ServerStatus.Initializing, 'starting');

        try {
            await this.client.start();
            this.starting = false;
            this.statusBar.update(ServerStatus.Running, 'ready');
            this.logger.logInfo('Mago language server is ready');
        } catch (err) {
            this.starting = false;
            this.statusBar.update(ServerStatus.Error, 'failed to start');
            this.logger.logError(`Failed to start language server: ${err}`);
        }
    }

    async stop(): Promise<void> {
        if (this.client) {
            this.logger.logInfo('Stopping Mago language server');
            this.statusBar.update(ServerStatus.Stopped, 'stopped');
            await this.client.stop();
            this.client = null;
        }
    }

    async restart(): Promise<void> {
        this.logger.logInfo('Restarting Mago language server');
        await this.stop();
        await this.start();
    }

    getClient(): LanguageClient | null {
        return this.client;
    }

    private buildServerArgs(config: vscode.WorkspaceConfiguration, cwd: string): string[] {
        const globalArgs: string[] = [];

        const configPath = config.get<string>('configPath');
        if (configPath) {
            globalArgs.push('--config', path.resolve(cwd, configPath));
        }
        const phpVersion = config.get<string>('phpVersion');
        if (phpVersion) {
            globalArgs.push('--php-version', phpVersion);
        }
        const threads = config.get<number | null>('threads');
        if (threads != null) {
            globalArgs.push('--threads', String(threads));
        }
        if (config.get<boolean>('allowUnsupportedPhpVersion')) {
            globalArgs.push('--allow-unsupported-php-version');
        }
        if (config.get<boolean>('noVersionCheck')) {
            globalArgs.push('--no-version-check');
        }

        const subcommandArgs: string[] = ['language-server'];

        if (config.get<boolean>('noAnalyzer')) {
            subcommandArgs.push('--no-analyzer');
        }
        if (config.get<boolean>('noLinter')) {
            subcommandArgs.push('--no-linter');
        }
        if (config.get<boolean>('noFormatter')) {
            subcommandArgs.push('--no-formatter');
        }

        return [...globalArgs, ...subcommandArgs];
    }

    private spawnServer(execPath: string, args: string[], cwd: string): Promise<ChildProcess> {
        return new Promise<ChildProcess>((resolve, reject) => {
            const proc = spawn(execPath, args, {
                cwd,
                env: {
                    ...process.env,
                    // Disable color codes in server output
                    NO_COLOR: '1',
                },
            });

            proc.on('error', (err) => {
                this.logger.logError(`Failed to spawn mago: ${err.message}`);
                this.statusBar.update(ServerStatus.Error, 'spawn error');
                reject(err);
            });

            proc.stderr.on('data', (data: Buffer) => {
                this.logger.logDebug(`[server stderr] ${data.toString().trimEnd()}`);
            });

            proc.on('exit', (code, signal) => {
                const reason = signal ? `signal ${signal}` : `code ${code}`;
                this.logger.logInfo(`Mago server exited (${reason})`);
                this.statusBar.update(ServerStatus.Stopped, 'exited');
            });

            resolve(proc);
        });
    }
}
