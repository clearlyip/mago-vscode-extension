import * as vscode from 'vscode';
import type { LanguageServer } from './LanguageServer';
import type { LoggingService } from './LoggingService';

export function registerCommands(
    server: LanguageServer,
    logger: LoggingService,
    context: vscode.ExtensionContext,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('mago.restartServer', async () => {
            if (server.isStarting()) {
                vscode.window.showWarningMessage('Mago: server is already starting');
                return;
            }
            await server.restart();
        }),

        vscode.commands.registerCommand('mago.stopServer', async () => {
            await server.stop();
        }),

        vscode.commands.registerCommand('mago.showOutputChannel', () => {
            logger.show();
        }),
    );
}
