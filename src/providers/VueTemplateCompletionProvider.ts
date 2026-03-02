import * as vscode from "vscode";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { getRootTemplateBounds } from "../core/vueTemplateUtils";

/**
 * Vue Template Completion Provider
 * Provides completions in three template contexts:
 *   1. Mustache interpolation: {{ xxx }}
 *   2. Event handlers: @click="xxx"
 *   3. Bound attributes: :prop="xxx" / v-bind:prop="xxx"
 */
export class VueTemplateCompletionProvider implements vscode.CompletionItemProvider {
  private treeSitterParser: TreeSitterParser;

  // Document-version cache to avoid re-parsing on every keystroke
  private cache: {
    uri: string;
    version: number;
    properties: { name: string; source: string }[];
  } | null = null;

  private snapshotCache: {
    uri: string;
    version: number;
    text: string;
    templateStart: number;
    templateEnd: number;
  } | null = null;

  constructor() {
    this.treeSitterParser = TreeSitterParser.getInstance();
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | null> {
    if (!document.fileName.endsWith('.vue')) return null;

    const snapshot = this.getDocumentSnapshot(document);
    const offset = document.offsetAt(position);

    // Ensure cursor is inside <template> block (not in <script> or <style>)
    if (!this.isInsideTemplate(offset, snapshot.templateStart, snapshot.templateEnd)) {
      return null;
    }

    if (_token.isCancellationRequested) return null;

    // Determine which template context we're in
    const ctx = this.detectContext(document, position, snapshot.text, offset);
    if (!ctx) return null;

    // Get all component properties (with caching)
    const properties = await this.getProperties(document, snapshot.text);
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

  private getDocumentSnapshot(document: vscode.TextDocument): {
    text: string;
    templateStart: number;
    templateEnd: number;
  } {
    const uri = document.uri.toString();
    if (
      this.snapshotCache &&
      this.snapshotCache.uri === uri &&
      this.snapshotCache.version === document.version
    ) {
      return this.snapshotCache;
    }

    const text = document.getText();
    const bounds = getRootTemplateBounds(text);
    const snapshot = {
      text,
      templateStart: bounds ? bounds.openTagEnd : -1,
      templateEnd: bounds ? bounds.closeTagStart : -1,
    };
    this.snapshotCache = { uri, version: document.version, ...snapshot };
    return snapshot;
  }

  private isInsideTemplate(offset: number, templateStart: number, templateEnd: number): boolean {
    if (templateStart < 0 || templateEnd < 0) {
      return false;
    }
    return offset > templateStart && offset < templateEnd;
  }

  /**
   * Detect which template context the cursor is in.
   * Returns null if not in a completable context.
   *
   * Handles ALL Vue directive patterns with modifiers:
   *   @click.stop.prevent="xxx"
   *   @keyup.enter="xxx"
   *   :value.sync="xxx"
   *   v-on:click.native="xxx"
   *   v-bind:prop.camel="xxx"
   *   v-model.lazy.number="xxx"
   *   v-if="xxx"  v-show="xxx"  v-for="xxx"  v-text="xxx"  v-html="xxx"
   */
  private detectContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    text: string,
    offset: number
  ): { type: 'mustache' | 'event' | 'bind' } | null {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // 1. Mustache interpolation: cursor is after {{ and no closing }}
    if (this.isInsideMustache(text, offset)) {
      return { type: 'mustache' };
    }

    // 2. Check if we're inside a directive attribute value (single or double quoted)
    //    Unified regex matches the directive prefix, optional modifiers, = sign, and unclosed quote
    const attrMatch = textBeforeCursor.match(
      /(?:(@[\w-]+(?:\.[\w-]+)*)|(:[\w-]+(?:\.[\w-]+)*)|(v-on:[\w-]+(?:\.[\w-]+)*)|(v-bind:[\w-]+(?:\.[\w-]+)*)|(v-model(?:\.[\w-]+)*)|(v-(?:if|else-if|show|for|text|html)(?:\.[\w-]+)*))\s*=\s*(?:"[^"]*|'[^']*)$/
    );

    if (attrMatch) {
      // Groups: 1=@event, 2=:bind, 3=v-on:event, 4=v-bind:bind, 5=v-model, 6=v-directive
      if (attrMatch[1] || attrMatch[3]) {
        return { type: 'event' };
      }
      return { type: 'bind' };
    }

    return null;
  }

  /**
   * Check if cursor is inside a Mustache interpolation {{ }}.
   * Scans backwards from cursor to find an unclosed {{.
   */
  private isInsideMustache(text: string, offset: number): boolean {
    // Scan backwards from cursor looking for {{ or }}
    let depth = 0;
    for (let i = offset - 1; i >= 1; i--) {
      if (text[i] === '{' && text[i - 1] === '{') {
        if (depth === 0) return true;
        depth--;
        i--; // skip the extra {
      } else if (text[i] === '}' && text[i - 1] === '}') {
        depth++;
        i--; // skip the extra }
      }
    }
    return false;
  }

  /**
   * Get component properties with document-version caching.
   */
  private async getProperties(
    document: vscode.TextDocument,
    content: string
  ): Promise<{ name: string; source: string }[]> {
    const uri = document.uri.toString();
    const version = document.version;

    if (this.cache && this.cache.uri === uri && this.cache.version === version) {
      return this.cache.properties;
    }

    const properties = await this.treeSitterParser.collectVueOptionProperties(content);
    this.cache = { uri, version, properties };
    return properties;
  }

  /**
   * Filter properties based on the template context type.
   */
  private filterByContext(
    properties: { name: string; source: string }[],
    contextType: 'mustache' | 'event' | 'bind'
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
