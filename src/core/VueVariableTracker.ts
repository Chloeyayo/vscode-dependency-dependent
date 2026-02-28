import * as vscode from 'vscode';
import { TreeSitterParser } from './TreeSitterParser';

// --- Types ---

export interface CallChainStep {
    type: 'call' | 'assignment' | 'data_init';
    label: string;
    start: number;
    end: number;
    children?: CallChainStep[];
}

export interface VariableTracePath {
    entryType: 'lifecycle' | 'watch';
    entryName: string;
    entryStart: number;
    entryEnd: number;
    callChain: CallChainStep[];
}

export interface VariableTrackingResult {
    targetVariable: string;
    dataInit: { variableName: string; valueText: string; start: number; end: number } | null;
    paths: VariableTracePath[];
    uri: vscode.Uri;
}

// Lifecycle order for sorting paths
const LIFECYCLE_ORDER: Record<string, number> = {
    'beforeCreate': 10,
    'created': 20,
    'beforeMount': 30,
    'mounted': 40,
    'beforeUpdate': 50,
    'updated': 60,
    'activated': 70,
    'deactivated': 80,
    'beforeDestroy': 90,
    'destroyed': 100,
    'errorCaptured': 110,
};

export class VueVariableTracker {
    private treeSitterParser: TreeSitterParser;

    constructor() {
        this.treeSitterParser = TreeSitterParser.getInstance();
    }

    /**
     * Track a variable through the component's lifecycle, following method call chains.
     */
    public async trackVariable(content: string, variableName: string, uri: vscode.Uri): Promise<VariableTrackingResult> {
        const scriptInfo = this.treeSitterParser.extractVueScriptInfo(content);
        if (!scriptInfo) {
            return { targetVariable: variableName, dataInit: null, paths: [], uri };
        }

        const { scriptContent, scriptOffset } = scriptInfo;
        const callGraph = await this.treeSitterParser.buildComponentCallGraph(scriptContent);

        // Get data init value (adjusted for script offset)
        let dataInit: VariableTrackingResult['dataInit'] = null;
        const rawInit = callGraph.dataInitialValues.get(variableName);
        if (rawInit) {
            dataInit = {
                variableName: rawInit.variableName,
                valueText: rawInit.valueText,
                start: rawInit.start + scriptOffset,
                end: rawInit.end + scriptOffset,
            };
        }

        const paths: VariableTracePath[] = [];

        // DFS from each lifecycle / watcher entry point
        for (const [methodKey, method] of callGraph.methods) {
            if (!method.isLifecycle && !method.isWatcher) continue;

            const callChain = this.dfsTrace(methodKey, variableName, callGraph.methods, new Set(), scriptOffset);
            if (callChain.length > 0) {
                let entryType: 'lifecycle' | 'watch' = method.isLifecycle ? 'lifecycle' : 'watch';
                let entryName = method.isWatcher ? `watch('${method.watchTarget}')` : method.name;

                paths.push({
                    entryType,
                    entryName,
                    entryStart: method.start + scriptOffset,
                    entryEnd: method.end + scriptOffset,
                    callChain,
                });
            }
        }

        // Sort paths by lifecycle order
        paths.sort((a, b) => {
            const wA = this.getEntryWeight(a);
            const wB = this.getEntryWeight(b);
            if (wA !== wB) return wA - wB;
            return a.entryStart - b.entryStart;
        });

        return { targetVariable: variableName, dataInit, paths, uri };
    }

    /**
     * DFS traversal: follow method calls from `currentMethod`, collecting
     * all call chain steps that eventually reach an assignment to `targetVar`.
     */
    private dfsTrace(
        currentMethodKey: string,
        targetVar: string,
        methods: Map<string, {
            name: string;
            calls: { methodName: string; start: number; end: number }[];
            assignments: { variableName: string; fullExpression: string; start: number; end: number }[];
            start: number;
            end: number;
        }>,
        visited: Set<string>,
        scriptOffset: number
    ): CallChainStep[] {
        if (visited.has(currentMethodKey)) return [];
        visited.add(currentMethodKey);

        const method = methods.get(currentMethodKey);
        if (!method) return [];

        const steps: CallChainStep[] = [];

        // Merge calls and assignments into a single timeline sorted by position
        type Item = { kind: 'call'; idx: number; start: number } | { kind: 'assign'; idx: number; start: number };
        const items: Item[] = [];
        method.calls.forEach((c, i) => items.push({ kind: 'call', idx: i, start: c.start }));
        method.assignments.forEach((a, i) => items.push({ kind: 'assign', idx: i, start: a.start }));
        items.sort((a, b) => a.start - b.start);

        for (const item of items) {
            if (item.kind === 'assign') {
                const assign = method.assignments[item.idx];
                if (assign.variableName === targetVar) {
                    steps.push({
                        type: 'assignment',
                        label: `this.${assign.variableName} = ${this.truncateExpression(assign.fullExpression)}`,
                        start: assign.start + scriptOffset,
                        end: assign.end + scriptOffset,
                    });
                }
            } else {
                const call = method.calls[item.idx];
                // Recurse into the called method
                const childSteps = this.dfsTrace(call.methodName, targetVar, methods, new Set(visited), scriptOffset);
                if (childSteps.length > 0) {
                    steps.push({
                        type: 'call',
                        label: `this.${call.methodName}()`,
                        start: call.start + scriptOffset,
                        end: call.end + scriptOffset,
                        children: childSteps,
                    });
                }
            }
        }

        return steps;
    }

    private getEntryWeight(path: VariableTracePath): number {
        if (path.entryType === 'lifecycle') {
            return LIFECYCLE_ORDER[path.entryName] || 999;
        }
        // Watches after created
        return 25;
    }

    private truncateExpression(expr: string): string {
        // Extract right-hand side of assignment.
        // Match the first standalone `=` that is NOT part of `==`, `===`, `!=`, `<=`, `>=`, `=>`
        const match = expr.match(/(?<!=|!)=(?!=|>)/);
        if (!match || match.index === undefined) return expr;
        const rhs = expr.substring(match.index + 1).trim();
        if (rhs.length > 40) {
            return rhs.substring(0, 37) + '...';
        }
        return rhs;
    }
}
