import * as vscode from 'vscode';
import { TreeSitterParser } from './TreeSitterParser';

export interface TimelineEvent {
    type: 'lifecycle' | 'watch';
    name: string;
    start: number;
    end: number;
    actions: TimelineAction[];
    // Order index for sorting. Lifecycle hooks have fixed predefined order.
    // Watches are placed before the first lifecycle hook they trigger with, typically we can just show them after created.
    orderWeight: number; 
}

export interface TimelineAction {
    type: 'call' | 'assignment';
    label: string;
    start: number;
    end: number;
}

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

export class VueTimelineAnalyzer {
    private treeSitterParser: TreeSitterParser;

    constructor() {
        this.treeSitterParser = TreeSitterParser.getInstance();
    }

    /**
     * Analyze a Vue SFC content and return chronological timeline events.
     */
    public async analyze(content: string): Promise<TimelineEvent[]> {
        const scriptInfo = this.treeSitterParser.extractVueScriptInfo(content);
        if (!scriptInfo) {
            return [];
        }

        const { scriptContent, scriptOffset } = scriptInfo;
        const events = await this._analyzeTypeScript(scriptContent, scriptOffset);
        
        // Sort events chronologically based on Vue 2 lifecycle order
        events.sort((a, b) => {
            if (a.orderWeight !== b.orderWeight) {
                return a.orderWeight - b.orderWeight;
            }
            // If same weight (e.g., two watches), retain original source order
            return a.start - b.start;
        });

        return events;
    }

    private async _analyzeTypeScript(scriptContent: string, scriptOffset: number): Promise<TimelineEvent[]> {
        // Here we need to leverage the tree-sitter parser properly
        // For privacy reasons, we will use a new method on TreeSitterParser or implement it here
        // Since TreeSitterParser is a singleton with a cache, we can just get the tree.
        
        // Since the parseWithCache is private, we'll need to use the parser directly or add a method.
        // Actually, we can add a method to TreeSitterParser to support this.
        
        // Let's implement the public API proxying through TreeSitterParser
        const events = await this.treeSitterParser.getVueTimelineEvents(scriptContent);
        
        // Adjust offsets to match the original .vue file positions
        // Adjust offsets to match the original .vue file positions
        for (const event of events as any[]) {
            event.start += scriptOffset;
            event.end += scriptOffset;
            
            if (event.type === 'lifecycle') {
                event.orderWeight = LIFECYCLE_ORDER[event.name] || 999;
            } else if (event.type === 'watch') {
                // Watches with immediate: true run before created
                // Regular watches run conceptually after created
                event.orderWeight = event.isImmediate ? 15 : 25; 
            }

            for (const action of event.actions) {
                action.start += scriptOffset;
                action.end += scriptOffset;
            }
        }

        return events;
    }
}
