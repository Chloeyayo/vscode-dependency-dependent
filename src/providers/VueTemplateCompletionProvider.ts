import * as vscode from "vscode";
import { TreeSitterParser } from "../core/TreeSitterParser";

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

    // Ensure cursor is inside <template> block (not in <script> or <style>)
    if (!this.isInsideTemplate(document, position)) return null;

    if (_token.isCancellationRequested) return null;

    // Determine which template context we're in
    const ctx = this.detectContext(document, position);
    if (!ctx) return null;

    // Get all component properties (with caching)
    const properties = await this.getProperties(document);
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
   * Check if the cursor position is inside the <template> block.
   */
  private isInsideTemplate(document: vscode.TextDocument, position: vscode.Position): boolean {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Find root-level <template> and </template>
    const templateStart = text.match(/^<template[\s>]/m);
    if (!templateStart || templateStart.index === undefined) return false;

    // Find the end of the opening <template> tag
    const openTagEnd = text.indexOf('>', templateStart.index);
    if (openTagEnd === -1 || offset <= openTagEnd) return false;

    // Find root-level </template>
    const templateEndMatch = text.match(/^<\/template\s*>/m);
    if (!templateEndMatch || templateEndMatch.index === undefined) return false;

    return offset > openTagEnd && offset < templateEndMatch.index;
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
    position: vscode.Position
  ): { type: 'mustache' | 'event' | 'bind' } | null {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // 1. Mustache interpolation: cursor is after {{ and no closing }}
    if (this.isInsideMustache(document, position)) {
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
  private isInsideMustache(document: vscode.TextDocument, position: vscode.Position): boolean {
    const text = document.getText();
    const offset = document.offsetAt(position);

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
    document: vscode.TextDocument
  ): Promise<{ name: string; source: string }[]> {
    const uri = document.uri.toString();
    const version = document.version;

    if (this.cache && this.cache.uri === uri && this.cache.version === version) {
      return this.cache.properties;
    }

    const content = document.getText();
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
