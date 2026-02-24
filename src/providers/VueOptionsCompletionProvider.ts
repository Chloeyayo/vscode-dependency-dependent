import * as vscode from "vscode";
import { TreeSitterParser } from "../core/TreeSitterParser";

/**
 * Vue2 Options API Completion Provider
 * Provides IntelliSense for `this.` in Vue components:
 * - this.xxx -> data properties
 * - this.xxx -> methods
 * - this.xxx -> computed properties
 * - this.xxx -> props
 */
export class VueOptionsCompletionProvider implements vscode.CompletionItemProvider {
  private treeSitterParser: TreeSitterParser;

  constructor() {
    this.treeSitterParser = TreeSitterParser.getInstance();
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | null> {
    // Check if we're in a .vue file
    if (!document.fileName.endsWith('.vue')) return null;

    // Match "this." followed by optional partial identifier (e.g. "this.", "this.f", "this.form")
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);
    const match = textBeforeCursor.match(/\bthis\.(\w*)$/);
    if (!match) return null;

    // Calculate the range to replace: from right after "this." to current cursor
    const alreadyTyped = match[1]; // e.g. "f" in "this.f"
    const dotOffset = position.character - alreadyTyped.length;
    const replaceRange = new vscode.Range(
      position.line, dotOffset,
      position.line, position.character
    );

    const fileContent = document.getText();

    try {
      const properties = await this.treeSitterParser.collectVueOptionProperties(fileContent);

      if (!properties || properties.length === 0) return null;

      const items = properties.map((prop) => {
        const item = new vscode.CompletionItem(prop.name, this.getCompletionKind(prop.source));
        item.detail = `(${prop.source})`;
        item.documentation = new vscode.MarkdownString(
          `Vue Options API — **${prop.source}** property`
        );
        // Ensure consistent ordering: group by source, then alphabetical
        item.sortText = `0_${this.getSourceOrder(prop.source)}_${prop.name}`;
        item.filterText = prop.name;
        item.range = replaceRange;
        // Boost priority so our items appear above default word suggestions
        item.preselect = false;
        return item;
      });

      // isIncomplete: false tells VS Code to cache and filter locally
      return new vscode.CompletionList(items, false);
    } catch (e) {
      console.error("VueOptionsCompletionProvider error:", e);
      return null;
    }
  }

  private getCompletionKind(source: string): vscode.CompletionItemKind {
    switch (source) {
      case 'data':
        return vscode.CompletionItemKind.Field;
      case 'computed':
        return vscode.CompletionItemKind.Property;
      case 'methods':
        return vscode.CompletionItemKind.Method;
      case 'props':
        return vscode.CompletionItemKind.Variable;
      default:
        return vscode.CompletionItemKind.Text;
    }
  }

  private getSourceOrder(source: string): string {
    // Order: data first, then computed, methods, props
    switch (source) {
      case 'data':     return '0';
      case 'computed': return '1';
      case 'methods':  return '2';
      case 'props':    return '3';
      default:         return '9';
    }
  }
}
