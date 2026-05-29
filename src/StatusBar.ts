import * as vscode from 'vscode';

export enum ServerStatus {
    Initializing = 'initializing',
    Running = 'running',
    Analyzing = 'analyzing',
    Idle = 'idle',
    Error = 'error',
    Stopped = 'stopped',
}

const STATUS_ICONS: Record<ServerStatus, string> = {
    [ServerStatus.Initializing]: '$(loading~spin)',
    [ServerStatus.Running]: '$(check)',
    [ServerStatus.Analyzing]: '$(loading~spin)',
    [ServerStatus.Idle]: '$(check)',
    [ServerStatus.Error]: '$(error)',
    [ServerStatus.Stopped]: '$(stop-circle)',
};

export class StatusBar {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'mago.showOutputChannel';
    }

    update(status: ServerStatus, detail?: string): void {
        const icon = STATUS_ICONS[status];
        this.item.text = detail ? `${icon} Mago: ${detail}` : `${icon} Mago`;
        this.item.tooltip = `Mago PHP — ${status}`;

        const config = vscode.workspace.getConfiguration('mago');
        if (status === ServerStatus.Running && config.get<boolean>('hideStatusBarWhenRunning')) {
            this.item.hide();
        } else {
            this.item.show();
        }
    }

    hide(): void {
        this.item.hide();
    }

    show(): void {
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
    }
}
