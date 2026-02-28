import * as vscode from 'vscode';
import * as path from 'path';
import { VueTimelineAnalyzer, TimelineEvent, TimelineAction } from '../core/VueTimelineAnalyzer';
import { VariableTrackingResult, CallChainStep } from '../core/VueVariableTracker';

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

/**
 * Tree item for tracking mode — displays call chain steps with nesting.
 */
export class TrackingTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly trackingType: 'root' | 'data-init' | 'entry' | 'call' | 'assignment',
        public readonly start: number,
        public readonly end: number,
        public readonly uri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly children?: CallChainStep[],
        public readonly pathIndex?: number
    ) {
        super(label, collapsibleState);
        this.contextValue = `tracking-${trackingType}`;

        switch (trackingType) {
            case 'root':
                this.iconPath = new vscode.ThemeIcon('graph');
                break;
            case 'data-init':
                this.iconPath = new vscode.ThemeIcon('database');
                break;
            case 'entry':
                this.iconPath = new vscode.ThemeIcon('symbol-event');
                break;
            case 'call':
                this.iconPath = new vscode.ThemeIcon('arrow-right');
                break;
            case 'assignment':
                this.iconPath = new vscode.ThemeIcon('symbol-field');
                break;
        }

        if (trackingType !== 'root') {
            this.command = {
                title: "Jump",
                command: "dependency-dependent.vueTimeline.jumpToLocation",
                arguments: [this]
            };
        }
    }
}

type AnyTreeItem = TimelineTreeItem | TrackingTreeItem;

export class VueTimelineProvider implements vscode.TreeDataProvider<AnyTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AnyTreeItem | undefined | null | void> = new vscode.EventEmitter<AnyTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<AnyTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private analyzer: VueTimelineAnalyzer;
    private currentEvents: TimelineEvent[] = [];
    private currentUri: vscode.Uri | undefined;

    // Tracking mode state
    private trackingMode = false;
    private trackingResult: VariableTrackingResult | null = null;
    private trackingVariableName: string = '';
    public treeView: vscode.TreeView<AnyTreeItem> | undefined;

    constructor() {
        this.analyzer = new VueTimelineAnalyzer();

        // Listen to active editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (this.trackingMode) return; // Don't refresh in tracking mode
            if (editor && editor.document.languageId === 'vue') {
                this.refresh(editor.document);
            } else {
                this.clear();
            }
        });

        // Listen to document saves
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'vue' && vscode.window.activeTextEditor?.document === document) {
                if (this.trackingMode) {
                    // Re-run tracking on save
                    this.enterTrackingMode(this.trackingVariableName, document);
                } else {
                    this.refresh(document);
                }
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

    public async enterTrackingMode(variableName: string, document: vscode.TextDocument): Promise<void> {
        try {
            this.trackingMode = true;
            this.trackingVariableName = variableName;
            this.currentUri = document.uri;
            const content = document.getText();
            this.trackingResult = await this.analyzer.trackVariable(content, variableName, document.uri);
            vscode.commands.executeCommand('setContext', 'dependency-dependent.trackingMode', true);
            this._onDidChangeTreeData.fire();
        } catch (e) {
            console.error("VueTimelineProvider tracking error:", e);
            this.exitTrackingMode();
        }
    }

    public exitTrackingMode(): void {
        this.trackingMode = false;
        this.trackingResult = null;
        this.trackingVariableName = '';
        vscode.commands.executeCommand('setContext', 'dependency-dependent.trackingMode', false);

        // Refresh back to normal timeline
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'vue') {
            this.refresh(editor.document);
        } else {
            this._onDidChangeTreeData.fire();
        }
    }

    getTreeItem(element: AnyTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: AnyTreeItem): Thenable<AnyTreeItem[]> {
        if (this.trackingMode) {
            return this.getTrackingChildren(element);
        }

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
        } else if (element instanceof TimelineTreeItem && (element.type === 'lifecycle' || element.type === 'watch')) {
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

    private getTrackingChildren(element?: AnyTreeItem): Thenable<AnyTreeItem[]> {
        if (!this.trackingResult || !this.currentUri) {
            return Promise.resolve([]);
        }

        const result = this.trackingResult;
        const uri = this.currentUri;

        if (!element) {
            // Root: show "Track: variableName"
            const rootItem = new TrackingTreeItem(
                `Track: ${result.targetVariable}`,
                'root',
                0, 0, uri,
                vscode.TreeItemCollapsibleState.Expanded
            );
            return Promise.resolve([rootItem]);
        }

        if (element instanceof TrackingTreeItem && element.trackingType === 'root') {
            const items: TrackingTreeItem[] = [];

            // Data init entry
            if (result.dataInit) {
                items.push(new TrackingTreeItem(
                    `data() → ${result.dataInit.variableName}: ${result.dataInit.valueText}`,
                    'data-init',
                    result.dataInit.start, result.dataInit.end, uri,
                    vscode.TreeItemCollapsibleState.None
                ));
            }

            // Lifecycle/watcher entry points
            for (let i = 0; i < result.paths.length; i++) {
                const p = result.paths[i];
                const icon = p.entryType === 'watch' ? 'watch' : 'entry';
                items.push(new TrackingTreeItem(
                    p.entryName,
                    'entry',
                    p.entryStart, p.entryEnd, uri,
                    vscode.TreeItemCollapsibleState.Expanded,
                    p.callChain,
                    i
                ));
            }

            return Promise.resolve(items);
        }

        // Entry or call node with children
        if (element instanceof TrackingTreeItem && (element.trackingType === 'entry' || element.trackingType === 'call')) {
            const steps = element.children;
            if (!steps || steps.length === 0) return Promise.resolve([]);

            const items = steps.map(step => {
                const hasChildren = step.children && step.children.length > 0;
                return new TrackingTreeItem(
                    step.label,
                    step.type === 'call' ? 'call' : 'assignment',
                    step.start, step.end, uri,
                    hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
                    step.children
                );
            });

            return Promise.resolve(items);
        }

        return Promise.resolve([]);
    }

    public async jumpToLocation(item: TimelineTreeItem | TrackingTreeItem) {
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
