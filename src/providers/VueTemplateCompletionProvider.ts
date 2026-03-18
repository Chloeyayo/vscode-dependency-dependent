import * as vscode from "vscode";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";
import {
  VueTemplateContextService,
  type VueTemplateCompletionType,
} from "../core/VueTemplateContextService";

/**
 * Vue Template Completion Provider
 * Provides completions in three template contexts:
 *   1. Mustache interpolation: {{ xxx }}
 *   2. Event handlers: @click="xxx"
 *   3. Bound attributes: :prop="xxx" / v-bind:prop="xxx"
 */
export class VueTemplateCompletionProvider implements vscode.CompletionItemProvider {
  private documentModels: VueDocumentModelManager;
  private templateContext: VueTemplateContextService;

  constructor() {
    this.documentModels = VueDocumentModelManager.getInstance();
    this.templateContext = VueTemplateContextService.getInstance();
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | null> {
    if (!document.fileName.endsWith('.vue')) return null;

    const model = this.documentModels.getDocumentModel(document);
    const offset = document.offsetAt(position);

    if (_token.isCancellationRequested) return null;

    const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
    const ctx = this.templateContext.detectCompletionContext(
      model.text,
      offset,
      linePrefix,
      model.templateBounds,
    );
    if (!ctx) return null;

    const properties = await model.getVueOptionProperties();
    if (!properties.length) return null;

    // Filter properties based on context
    const filtered = this.filterByContext(properties, ctx.type);

    // Build completion items
    const items: vscode.CompletionItem[] = filtered.map(prop => {
      const item = new vscode.CompletionItem(prop.name, this.getKind(prop.source));
      item.detail = prop.source;
      item.sortText = `0_${prop.name}`; // Sort before default suggestions

      if (prop.source === 'methods' && ctx.type === 'event') {
        // For event handlers, optionally add parentheses
        item.insertText = prop.name;
      }

      return item;
    });

    return new vscode.CompletionList(items, false);
  }

  /**
   * Filter properties based on the template context type.
   */
  private filterByContext(
    properties: { name: string; source: string }[],
    contextType: VueTemplateCompletionType
  ): { name: string; source: string }[] {
    switch (contextType) {
      case 'mustache':
        // All properties accessible in mustache
        return properties;
      case 'event':
        // Only methods for event handlers
        return properties.filter(p => p.source === 'methods');
      case 'bind':
        // data, computed, props for bound attributes (methods too for computed-like usage)
        return properties;
      default:
        return properties;
    }
  }

  /**
   * Map source type to completion item kind.
   */
  private getKind(source: string): vscode.CompletionItemKind {
    switch (source) {
      case 'data': return vscode.CompletionItemKind.Field;
      case 'methods': return vscode.CompletionItemKind.Method;
      case 'computed': return vscode.CompletionItemKind.Property;
      case 'props': return vscode.CompletionItemKind.Interface;
      case 'watch': return vscode.CompletionItemKind.Event;
      default: return vscode.CompletionItemKind.Variable;
    }
  }
}
