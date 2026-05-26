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

        const args = this.buildServerArgs(config);
        this.logger.logInfo(`Starting mago language server: ${execPath} ${args.join(' ')}`);

        const serverOptions: ServerOptions = () => this.spawnServer(execPath, args);

        const maxRestarts = config.get<number>('maxRestartCount') ?? 5;
        const errorHandler = new MagoErrorHandler(maxRestarts, this.logger, this.statusBar);

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ scheme: 'file', language: 'php' }],
            synchronize: {
                fileEvents: [
                    vscode.workspace.createFileSystemWatcher('**/*.php'),
                    vscode.workspace.createFileSystemWatcher('**/mago.toml'),
                    vscode.workspace.createFileSystemWatcher('**/composer.json'),
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

    private buildServerArgs(config: vscode.WorkspaceConfiguration): string[] {
        const args: string[] = ['language-server'];

        if (config.get<boolean>('noAnalyzer')) {
            args.push('--no-analyzer');
        }
        if (config.get<boolean>('noLinter')) {
            args.push('--no-linter');
        }
        if (config.get<boolean>('noFormatter')) {
            args.push('--no-formatter');
        }

        return args;
    }

    private spawnServer(execPath: string, args: string[]): Promise<ChildProcess> {
        return new Promise<ChildProcess>((resolve, reject) => {
            const proc = spawn(execPath, args, {
                cwd: this.workspacePath,
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
