import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { LanguageServer } from './LanguageServer';
import { LoggingService } from './LoggingService';
import { ServerStatus, StatusBar } from './StatusBar';

// Other VS Code extensions that also activate on PHP files and invoke the mago
// binary directly. Running more than one simultaneously causes doubled
// diagnostics and competing mago processes on every save.
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

    // Watch mago.toml and restart on change
    const tomlWatcher = vscode.workspace.createFileSystemWatcher('**/mago.toml');
    context.subscriptions.push(tomlWatcher);
    tomlWatcher.onDidChange(async () => {
        logger.logInfo('mago.toml changed, restarting server');
        await server.restart();
    });
    tomlWatcher.onDidCreate(async () => {
        logger.logInfo('mago.toml created, restarting server');
        await server.restart();
    });
    tomlWatcher.onDidDelete(async () => {
        logger.logInfo('mago.toml deleted, restarting server');
        await server.restart();
    });

    await server.start();

    logger.logInfo('Mago extension activated');
}

export async function deactivate(): Promise<void> {
    // The LanguageClient is stopped via its registered disposable when the
    // extension host disposes context.subscriptions. Nothing extra needed.
}
