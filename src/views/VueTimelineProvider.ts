import * as vscode from 'vscode';
import * as path from 'path';
import { VueTimelineAnalyzer, TimelineEvent, TimelineAction } from '../core/VueTimelineAnalyzer';

export class TimelineTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly type: 'lifecycle' | 'watch' | 'action',
        public readonly start: number,
        public readonly end: number,
        public readonly uri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly description?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = type;

        if (type === 'lifecycle') {
            this.iconPath = new vscode.ThemeIcon('symbol-event');
        } else if (type === 'watch') {
            this.iconPath = new vscode.ThemeIcon('eye');
        } else if (type === 'action') {
            this.iconPath = new vscode.ThemeIcon('git-commit');
        }

        this.command = {
            title: "Jump",
            command: "dependency-dependent.vueTimeline.jumpToLocation",
            arguments: [this]
        };
    }
}

export class VueTimelineProvider implements vscode.TreeDataProvider<TimelineTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TimelineTreeItem | undefined | null | void> = new vscode.EventEmitter<TimelineTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TimelineTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private analyzer: VueTimelineAnalyzer;
    private currentEvents: TimelineEvent[] = [];
    private currentUri: vscode.Uri | undefined;

    constructor() {
        this.analyzer = new VueTimelineAnalyzer();
        
        // Listen to active editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document.languageId === 'vue') {
                this.refresh(editor.document);
            } else {
                this.clear();
            }
        });

        // Listen to document saves
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'vue' && vscode.window.activeTextEditor?.document === document) {
                this.refresh(document);
            }
        });

        // Initial load
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'vue') {
            this.refresh(vscode.window.activeTextEditor.document);
        }
    }

    public async refresh(document?: vscode.TextDocument): Promise<void> {
        if (!document) {
            this.clear();
            return;
        }

        try {
            this.currentUri = document.uri;
            const content = document.getText();
            this.currentEvents = await this.analyzer.analyze(content);
            this._onDidChangeTreeData.fire();
        } catch (e) {
            console.error("VueTimelineProvider error:", e);
            this.clear();
        }
    }

    public clear(): void {
        this.currentEvents = [];
        this.currentUri = undefined;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TimelineTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TimelineTreeItem): Thenable<TimelineTreeItem[]> {
        if (!this.currentUri || this.currentEvents.length === 0) {
            return Promise.resolve([]);
        }

        if (!element) {
            // Root level: return all lifecycle events and watchers
            const items = this.currentEvents.map(event => {
                const hasChildren = event.actions && event.actions.length > 0;
                return new TimelineTreeItem(
                    event.name,
                    event.type,
                    event.start,
                    event.end,
                    this.currentUri!,
                    hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
                );
            });
            return Promise.resolve(items);
        } else if (element.type === 'lifecycle' || element.type === 'watch') {
            // Find the corresponding event and return its actions
            const event = this.currentEvents.find(e => e.name === element.label && e.start === element.start);
            if (event && event.actions) {
                const items = event.actions.map(action => {
                    return new TimelineTreeItem(
                        action.label,
                        'action',
                        action.start,
                        action.end,
                        this.currentUri!,
                        vscode.TreeItemCollapsibleState.None
                    );
                });
                return Promise.resolve(items);
            }
        }

        return Promise.resolve([]);
    }

    public async jumpToLocation(item: TimelineTreeItem) {
        if (!item.uri) return;
        
        try {
            const document = await vscode.workspace.openTextDocument(item.uri);
            const editor = await vscode.window.showTextDocument(document);
            
            const startPos = document.positionAt(item.start);
            const endPos = document.positionAt(item.end);
            
            editor.selection = new vscode.Selection(startPos, endPos);
            editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to jump to location: ${e}`);
        }
    }
}
