import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { LanguageServer } from './LanguageServer';
import { LoggingService } from './LoggingService';
import { ServerStatus, StatusBar } from './StatusBar';

// Other VS Code extensions that also activate on PHP files and invoke the mago
// binary directly. Running more than one simultaneously causes doubled
// diagnostics and competing mago processes on every save.
const RESTART_DEBOUNCE_MS = 500;

let activeServer: LanguageServer | undefined;

const CONFLICTING_EXTENSIONS: { id: string; name: string }[] = [
    { id: 'Michael4d45.mago-vscode', name: 'Mago (Michael4d45)' },
    { id: 'kgz.mago-unofficial', name: 'Mago Unofficial (kgz)' },
];

function checkForConflicts(logger: LoggingService): void {
    const active = CONFLICTING_EXTENSIONS.filter((ext) => vscode.extensions.getExtension(ext.id) !== undefined);

    if (active.length === 0) {
        return;
    }

    const names = active.map((e) => `"${e.name}"`).join(' and ');
    const message =
        `Mago: conflicting extension${active.length > 1 ? 's' : ''} detected — ${names} ` +
        `is also active. Both extensions run mago on PHP files, which causes duplicate diagnostics. ` +
        `Disable the other extension${active.length > 1 ? 's' : ''} to avoid conflicts.`;

    logger.logWarn(message);

    vscode.window.showWarningMessage(message, 'Open Extensions View').then((action) => {
        if (action === 'Open Extensions View') {
            vscode.commands.executeCommand('workbench.view.extensions');
        }
    });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const logger = new LoggingService();
    const statusBar = new StatusBar();

    const config = vscode.workspace.getConfiguration('mago');
    logger.setLevel(config.get('logLevel') ?? 'info');

    context.subscriptions.push(logger, statusBar);

    checkForConflicts(logger);

    if (!config.get<boolean>('suppressExperimentalWarning')) {
        vscode.window
            .showWarningMessage(
                'The Mago language server is a work in progress. ' +
                    'The set of advertised capabilities, the wire behaviour, the flags, and even the existence of this subcommand ' +
                    'can change or disappear without notice. ' +
                    'There are no compatibility guarantees until mago 2.0. ' +
                    'If you need a stable editor integration, wait for that release.',
                'Dismiss',
                "Don't show again",
            )
            .then((action) => {
                if (action === "Don't show again") {
                    config.update('suppressExperimentalWarning', true, vscode.ConfigurationTarget.Global);
                }
            });
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        logger.logError('Mago requires an open workspace folder');
        statusBar.update(ServerStatus.Error, 'no workspace');
        return;
    }

    const getWorkspacePath = (): string => {
        const active = vscode.window.activeTextEditor?.document.uri;
        const folder = active ? vscode.workspace.getWorkspaceFolder(active) : workspaceFolders[0];
        return (folder ?? workspaceFolders[0]).uri.fsPath;
    };

    const server = new LanguageServer(getWorkspacePath(), statusBar, logger);
    activeServer = server;
    context.subscriptions.push({ dispose: () => void server.dispose() });

    registerCommands(server, logger, context);

    // Restart when the active editor changes to a different workspace folder
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!editor) {
                return;
            }
            const newPath = getWorkspacePath();
            if (newPath !== server.getWorkspacePath()) {
                logger.logInfo(`Workspace changed to: ${newPath}`);
                server.setWorkspacePath(newPath);
                await server.restart();
            }
        }),
    );

    // Prompt user to reload when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('mago')) {
                return;
            }
            logger.setLevel(vscode.workspace.getConfiguration('mago').get('logLevel') ?? 'info');
            vscode.window
                .showInformationMessage('Mago settings changed. Reload window to apply?', 'Reload')
                .then((action) => {
                    if (action === 'Reload') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
        }),
    );

    // Watch the active config file and restart on change.
    // Respects mago.configPath: if set, watches that specific file; otherwise watches any mago.toml.
    const explicitConfigPath = config.get<string>('configPath');
    const tomlPattern: vscode.GlobPattern = explicitConfigPath
        ? path.isAbsolute(explicitConfigPath)
            ? new vscode.RelativePattern(
                  vscode.Uri.file(path.dirname(explicitConfigPath)),
                  path.basename(explicitConfigPath),
              )
            : new vscode.RelativePattern(workspaceFolders[0].uri, explicitConfigPath)
        : '**/mago.toml';
    const configLabel = explicitConfigPath || 'mago.toml';
    const tomlWatcher = vscode.workspace.createFileSystemWatcher(tomlPattern);
    context.subscriptions.push(tomlWatcher);

    // A mago.toml that lives in vendor/ or node_modules/ is a dependency's, never ours. Without this
    // filter, installing packages fires a burst of events that restarts the server over and over.
    const isIgnoredConfig = (uri: vscode.Uri): boolean =>
        !explicitConfigPath && /(^|[\\/])(vendor|node_modules|\.git)[\\/]/.test(uri.fsPath);

    // Coalesce bursts of watcher events into a single restart.
    let restartTimer: NodeJS.Timeout | undefined;
    const scheduleRestart = (uri: vscode.Uri, event: string): void => {
        if (isIgnoredConfig(uri)) {
            return;
        }
        logger.logInfo(`${configLabel} ${event}, restarting server`);
        if (restartTimer) {
            clearTimeout(restartTimer);
        }
        restartTimer = setTimeout(() => {
            restartTimer = undefined;
            void server.restart();
        }, RESTART_DEBOUNCE_MS);
    };
    context.subscriptions.push({
        dispose: () => {
            if (restartTimer) {
                clearTimeout(restartTimer);
            }
        },
    });
    tomlWatcher.onDidChange((uri) => scheduleRestart(uri, 'changed'));
    tomlWatcher.onDidCreate((uri) => scheduleRestart(uri, 'created'));
    tomlWatcher.onDidDelete((uri) => scheduleRestart(uri, 'deleted'));

    const started = await server.start();

    if (started) {
        logger.logInfo('Mago extension activated');
    }
}

export async function deactivate(): Promise<void> {
    // Await the stop here: disposables in context.subscriptions are not awaited by the host,
    // so relying on them alone can leave the server process running after the extension exits.
    await activeServer?.dispose();
    activeServer = undefined;
}
