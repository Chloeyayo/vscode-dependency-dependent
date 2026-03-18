import * as vscode from "vscode";
import { TreeSitterParser, type VueOptionsIndex, type VueOptionsIndexEntry } from "../core/TreeSitterParser";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";
import { VuePrototypeScanner, VueDollarProperty } from "../core/VuePrototypeScanner";

/**
 * Vue2 Options API Completion Provider
 * Provides IntelliSense for `this.` in Vue components:
 * - this.xxx -> data / methods / computed / props / watch
 * - this.$xxx -> Vue built-ins, plugins, custom properties
 */
export class VueOptionsCompletionProvider implements vscode.CompletionItemProvider {
  private documentModels: VueDocumentModelManager;
  private prototypeScanner: VuePrototypeScanner;

  constructor(prototypeScanner?: VuePrototypeScanner) {
    TreeSitterParser.getInstance();
    this.documentModels = VueDocumentModelManager.getInstance();
    this.prototypeScanner = prototypeScanner ?? new VuePrototypeScanner();
  }

  /**
   * Invalidate the $xxx workspace cache (called when package.json changes).
   */
  invalidatePrototypeCache(): void {
    this.prototypeScanner.invalidateCache();
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | null> {
    // Check if we're in a .vue file
    if (!document.fileName.endsWith('.vue')) return null;

    // Match "this." followed by optional partial identifier or nested chain
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // Check for nested property chain: this.obj.inner. or this.obj.
    const chainMatch = textBeforeCursor.match(/\bthis\.([$\w]+(?:\.[$\w]+)*)\.([$\w]*)$/);
    if (chainMatch) {
      return this.provideNestedCompletions(document, position, chainMatch);
    }

    const match = textBeforeCursor.match(/\bthis\.([$\w]*)$/);
    if (!match) return null;

    // Calculate the range to replace: from right after "this." to current cursor
    const alreadyTyped = match[1]; // e.g. "f" in "this.f" or "$r" in "this.$r"
    const dotOffset = position.character - alreadyTyped.length;
    const replaceRange = new vscode.Range(
      position.line, dotOffset,
      position.line, position.character
    );

    const items: vscode.CompletionItem[] = [];

    // ── Component properties (data / methods / computed / props / watch) ──
    if (token.isCancellationRequested) return null;
    let properties: VueOptionsIndexEntry[] = [];
    try {
      const index = await this.getIndex(document);
      properties = index.properties;
    } catch (e) {
      console.error("VueOptionsCompletionProvider error:", e);
    }

    for (const prop of properties) {
      const isMethod = prop.source === 'methods';
      const item = new vscode.CompletionItem(
        prop.name,
        this.getCompletionKind(prop.source)
      );
      item.detail = prop.inferredType
        ? `(${prop.source}) ${prop.inferredType}`
        : `(${prop.source})`;
      item.documentation = new vscode.MarkdownString(
        `Vue Options API — **${prop.source}** property`
      );
      item.sortText = `0_${this.getSourceOrder(prop.source)}_${prop.name}`;
      item.filterText = prop.name;
      item.range = replaceRange;

      if (isMethod) {
        const escaped = prop.name.replace(/\$/g, '\\$');
        item.insertText = new vscode.SnippetString(`${escaped}($0)`);
      }

      items.push(item);
    }

    // ── $xxx properties (builtins + plugins + entry files + config) ──
    if (token.isCancellationRequested) return null;
    try {
      const dollarProps = await this.prototypeScanner.getProperties(document);
      for (const dp of dollarProps) {
        const item = new vscode.CompletionItem(dp.name, dp.kind);
        item.detail = dp.detail;
        item.documentation = new vscode.MarkdownString(dp.documentation);
        item.sortText = `1_${dp.name}`; // sort after component properties
        item.filterText = dp.name;
        item.range = replaceRange;

        if (dp.isMethod) {
          const escaped = dp.name.replace(/\$/g, '\\$');
          item.insertText = new vscode.SnippetString(`${escaped}($0)`);
        }

        items.push(item);
      }
    } catch (e) {
      console.error("VuePrototypeScanner error:", e);
    }

    if (items.length === 0) return null;

    return new vscode.CompletionList(items, false);
  }

  private async provideNestedCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    chainMatch: RegExpMatchArray
  ): Promise<vscode.CompletionList | null> {
    const chain = chainMatch[1].split('.');    // e.g. ['obj'] or ['obj', 'inner']
    const alreadyTyped = chainMatch[2];        // partial text after last dot
    const dotOffset = position.character - alreadyTyped.length;
    const replaceRange = new vscode.Range(
      position.line, dotOffset,
      position.line, position.character
    );

    try {
      const chainKey = chain.join('.');
      const index = await this.getIndex(document);
      const nestedProps = index.childrenByPath.get(chainKey) || [];

      if (nestedProps.length === 0) return null;

      const items = nestedProps.map(prop => {
        const item = new vscode.CompletionItem(prop.name, vscode.CompletionItemKind.Field);
        item.detail = prop.inferredType
          ? `(${chain.join('.')}) ${prop.inferredType}`
          : `(${chain.join('.')})`;
        item.sortText = `0_${prop.name}`;
        item.filterText = prop.name;
        item.range = replaceRange;
        return item;
      });

      return new vscode.CompletionList(items, false);
    } catch (e) {
      console.error("VueOptionsCompletionProvider nested error:", e);
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
      case 'watch':
        return vscode.CompletionItemKind.Event;
      default:
        return vscode.CompletionItemKind.Text;
    }
  }

  private getSourceOrder(source: string): string {
    switch (source) {
      case 'data':     return '0';
      case 'computed': return '1';
      case 'methods':  return '2';
      case 'props':    return '3';
      case 'watch':    return '4';
      default:         return '9';
    }
  }

  private async getIndex(document: vscode.TextDocument): Promise<VueOptionsIndex> {
    return this.documentModels.getDocumentModel(document).getVueOptionsIndex();
  }
}
