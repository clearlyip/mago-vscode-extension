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
 * Returns true when the file at `execPath` is a PHP launcher script
 * (i.e. starts with "#!/usr/bin/env php"). The Composer-installed
 * vendor/bin/mago-lsp is such a script: on first invocation it downloads
 * the real binary before exec-ing into it, which can take well over 5 s.
 */
function isPhpLauncherScript(execPath: string): boolean {
    try {
        const buf = Buffer.alloc(20);
        const fd = fs.openSync(execPath, 'r');
        fs.readSync(fd, buf, 0, 20, 0);
        fs.closeSync(fd);
        return buf.toString('utf8').startsWith('#!/usr/bin/env php');
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
 * `timeoutMs` defaults to 5 s for native binaries; callers should pass a
 * much larger value when the path is a PHP launcher that may need to download
 * the binary on first run.
 */
function hasLanguageServerSupport(execPath: string, timeoutMs = 5_000): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(
            execPath,
            ['--help'],
            { timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1' } },
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

    async start(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('mago');

        const configuredWorkspace = config.get<string>('workspace');
        const cwd = configuredWorkspace ? path.resolve(this.workspacePath, configuredWorkspace) : this.workspacePath;

        if (configuredWorkspace && !fs.existsSync(cwd)) {
            const msg = `mago.workspace path does not exist: ${cwd}`;
            this.logger.logError(msg);
            this.statusBar.update(ServerStatus.Error, 'invalid workspace');
            vscode.window.showErrorMessage(`Mago: ${msg}`, 'Open Settings').then((action) => {
                if (action === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'mago.workspace');
                }
            });
            return false;
        }

        const rawExec = config.get<string>('executablePath') || 'mago';

        const explicitConfigPath = config.get<string>('configPath');
        const resolvedConfigPath = explicitConfigPath
            ? path.resolve(cwd, explicitConfigPath)
            : path.join(cwd, 'mago.toml');

        if (!fs.existsSync(resolvedConfigPath)) {
            if (explicitConfigPath) {
                const msg = `mago.configPath file does not exist: ${resolvedConfigPath}`;
                this.logger.logError(msg);
                this.statusBar.update(ServerStatus.Error, 'config not found');
                vscode.window.showErrorMessage(`Mago: ${msg}`, 'Open Settings').then((action) => {
                    if (action === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'mago.configPath');
                    }
                });
            } else {
                this.logger.logInfo(`No mago.toml found in ${cwd}, language server will not start.`);
                this.statusBar.hide();
            }
            return false;
        }
        const execPath = resolveMagoPath(rawExec, this.workspacePath);

        if (!isMagoExecutable(execPath)) {
            const isDefault = rawExec === 'mago';
            if (isDefault) {
                this.logger.logInfo(`Mago executable not found at: ${execPath}, language server will not start.`);
                this.statusBar.update(ServerStatus.Stopped, 'not found');
            } else {
                this.logger.logError(
                    `Mago executable not found or not executable at: ${execPath}\nSet mago.executablePath to the correct path.`,
                );
                this.statusBar.update(ServerStatus.Error, 'not found');
                vscode.window
                    .showErrorMessage(
                        `Mago: executable not found at "${execPath}". Check mago.executablePath.`,
                        'Open Settings',
                    )
                    .then((action) => {
                        if (action === 'Open Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'mago.executablePath');
                        }
                    });
            }
            return false;
        }

        const phpLauncher = isPhpLauncherScript(execPath);
        if (phpLauncher) {
            this.logger.logInfo(
                'Detected PHP launcher script — binary will be downloaded on first run. This may take a moment.',
            );
            this.statusBar.update(ServerStatus.Initializing, 'downloading...');
        }

        if (!(await hasLanguageServerSupport(execPath, phpLauncher ? 300_000 : 5_000))) {
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
            return false;
        }

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

        const { paths: sourcePaths, excludes: sourceExcludes } = await readMagoSourceConfig(resolvedConfigPath);
        // Paths wholly covered by an exclude are dead — skip them so the filter isn't overly permissive.
        const activePaths = sourcePaths.filter((p) => !sourceExcludes.some((ex) => p === ex || p.startsWith(`${ex}/`)));

        const isPathAllowed = (fsPath: string): boolean => {
            if (config.get<boolean>('disableFileFilter')) {
                return true;
            }
            if (
                sourceExcludes.some((ex) => {
                    const abs = path.join(cwd, ex);
                    this.logger.logDebug(`Checking active path: ${abs} against ${fsPath}`);
                    return fsPath === abs || fsPath.startsWith(abs);
                })
            ) {
                this.logger.logDebug(`Excluding ${fsPath} due to mago.toml source.excludes`);
                return false;
            }
            if (
                activePaths.length > 0 &&
                !activePaths.some((p) => {
                    const abs = path.join(cwd, p);
                    this.logger.logDebug(`Checking active path: ${abs} against ${fsPath}`);
                    return fsPath === abs || fsPath.startsWith(abs);
                })
            ) {
                this.logger.logDebug(`Excluding ${fsPath} due to mago.toml source.includes`);
                return false;
            }
            this.logger.logDebug(`Allowing ${fsPath}`);
            return true;
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ scheme: 'file', language: 'php' }],
            workspaceFolder: clientWorkspaceFolder,
            synchronize: {
                fileEvents: [
                    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(watchBase, '**/mago.toml')),
                    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(watchBase, '**/composer.lock')),
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
            middleware: {
                didOpen: async (document, next) => {
                    if (isPathAllowed(document.uri.fsPath)) {
                        await next(document);
                    }
                },
                didChange: async (event, next) => {
                    if (isPathAllowed(event.document.uri.fsPath)) {
                        await next(event);
                    }
                },
                didSave: async (document, next) => {
                    if (isPathAllowed(document.uri.fsPath)) {
                        await next(document);
                    }
                },
                didClose: async (document, next) => {
                    if (isPathAllowed(document.uri.fsPath)) {
                        await next(document);
                    }
                },
                workspace: {
                    didChangeWatchedFile: async (event, next) => {
                        // Only filter PHP notifications; let mago.toml / composer.json through unconditionally.
                        if (!event.uri.endsWith('.php') || isPathAllowed(vscode.Uri.parse(event.uri).fsPath)) {
                            await next(event);
                        }
                    },
                },
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
            return true;
        } catch (err) {
            this.starting = false;
            this.statusBar.update(ServerStatus.Error, 'failed to start');
            this.logger.logError(`Failed to start language server: ${err}`);
            return false;
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

    async restart(): Promise<boolean> {
        this.logger.logInfo('Restarting Mago language server');
        await this.stop();
        return this.start();
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
