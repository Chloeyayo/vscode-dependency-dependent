import * as vscode from "vscode";

/**
 * SFC region info: the block's content range within the Vue file.
 */
interface SFCRegion {
  /** Language id for the virtual document */
  langId: string;
  /** Offset of the first char of the block content (after the opening tag's >) */
  contentStart: number;
  /** Offset of the last char of the block content (before the closing tag's <) */
  contentEnd: number;
}

/** Custom scheme for virtual formatting documents (invisible to the tab bar). */
const SCHEME = "vue-format";

/**
 * In-memory content provider so that `vscode.workspace.openTextDocument(uri)`
 * can resolve our virtual URIs without creating untitled (visible) tabs.
 */
class VueFormatContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();

  set(key: string, content: string): void {
    this.contents.set(key, content);
  }

  delete(key: string): void {
    this.contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? "";
  }
}

/**
 * Vue Range Formatting Provider
 * Enables "Format Selection" (Ctrl+K Ctrl+F) in .vue files by:
 *   1. Detecting which SFC region (template/script/style) the selection is in
 *   2. Creating a virtual document in the region's language
 *   3. Delegating to VS Code's built-in formatter for that language
 *   4. Mapping the resulting edits back to the original .vue file
 */
export class VueRangeFormattingProvider implements vscode.DocumentRangeFormattingEditProvider, vscode.DocumentFormattingEditProvider {
  private contentProvider = new VueFormatContentProvider();
  private registration: vscode.Disposable;
  private seq = 0;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      SCHEME,
      this.contentProvider
    );
  }

  dispose(): void {
    this.registration.dispose();
  }

  /**
   * Open a virtual document under the `vue-format` scheme.
   * The document is invisible (no tab) because it uses a custom scheme.
   */
  private async openVirtualDoc(langId: string, content: string): Promise<vscode.TextDocument> {
    const ext = this.langIdToExt(langId);
    const key = `/${this.seq++}${ext}`;
    this.contentProvider.set(key, content);
    const uri = vscode.Uri.parse(`${SCHEME}:${key}`);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      // Force VS Code to recognize the language so formatters activate
      await vscode.languages.setTextDocumentLanguage(doc, langId);
      return doc;
    } catch {
      this.contentProvider.delete(key);
      throw new Error(`Failed to open virtual doc for ${langId}`);
    }
  }

  private cleanupVirtualDoc(doc: vscode.TextDocument): void {
    this.contentProvider.delete(doc.uri.path);
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const text = document.getText();
    const regions = this.parseRegions(text);
    const allEdits: vscode.TextEdit[] = [];

    for (let i = 0; i < regions.length; i++) {
      if (_token.isCancellationRequested) break;
      const region = regions[i];
      const regionContent = text.substring(region.contentStart, region.contentEnd);

      let virtualDoc: vscode.TextDocument | undefined;
      try {
        virtualDoc = await this.openVirtualDoc(region.langId, regionContent);

        // Preserve structural newlines between block tags and content
        // e.g. the \n after <template> and the \n before </template>
        const leadingNL = regionContent.match(/^\r?\n/);
        const trailingNL = regionContent.match(/\r?\n[\t ]*$/);
        const formatStart = leadingNL ? leadingNL[0].length : 0;
        const formatEnd = trailingNL ? regionContent.length - trailingNL[0].length : regionContent.length;

        const virtualRange = new vscode.Range(
          virtualDoc.positionAt(formatStart),
          virtualDoc.positionAt(formatEnd)
        );

        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
          'vscode.executeFormatRangeProvider',
          virtualDoc.uri,
          virtualRange,
          options
        );

        if (edits && edits.length > 0) {
          const mappedEdits = edits.map(edit => {
            const origStartOffset = region.contentStart + virtualDoc!.offsetAt(edit.range.start);
            const origEndOffset = region.contentStart + virtualDoc!.offsetAt(edit.range.end);
            const origRange = new vscode.Range(
              document.positionAt(origStartOffset),
              document.positionAt(origEndOffset)
            );
            return new vscode.TextEdit(origRange, edit.newText);
          });
          allEdits.push(...mappedEdits);
        }
      } catch {
        // Continue to the next region if one fails
      } finally {
        if (virtualDoc) this.cleanupVirtualDoc(virtualDoc);
      }
    }

    return allEdits;
  }

  async provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const text = document.getText();
    const regions = this.parseRegions(text);

    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);

    const region = regions.find(
      r => startOffset >= r.contentStart && endOffset <= r.contentEnd
    );

    if (!region) {
      return [];
    }

    if (_token.isCancellationRequested) return [];
    const regionContent = text.substring(region.contentStart, region.contentEnd);

    const relativeStartOffset = startOffset - region.contentStart;
    const relativeEndOffset = endOffset - region.contentStart;

    let virtualDoc: vscode.TextDocument | undefined;
    try {
      virtualDoc = await this.openVirtualDoc(region.langId, regionContent);

      const virtualStart = virtualDoc.positionAt(relativeStartOffset);
      const virtualEnd = virtualDoc.positionAt(relativeEndOffset);
      const virtualRange = new vscode.Range(virtualStart, virtualEnd);

      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatRangeProvider',
        virtualDoc.uri,
        virtualRange,
        options
      );

      if (!edits || edits.length === 0) return [];

      const mappedEdits: vscode.TextEdit[] = edits.map(edit => {
        const origStartOffset = region.contentStart + virtualDoc!.offsetAt(edit.range.start);
        const origEndOffset = region.contentStart + virtualDoc!.offsetAt(edit.range.end);
        const origRange = new vscode.Range(
          document.positionAt(origStartOffset),
          document.positionAt(origEndOffset)
        );
        return new vscode.TextEdit(origRange, edit.newText);
      });

      return mappedEdits;
    } catch {
      return [];
    } finally {
      if (virtualDoc) this.cleanupVirtualDoc(virtualDoc);
    }
  }

  /**
   * Parse the Vue SFC file to find template, script, and style regions.
   */
  private parseRegions(text: string): SFCRegion[] {
    const regions: SFCRegion[] = [];

    const blockPattern = /<(template|script|style)(\b[^>]*)>/gi;
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(text)) !== null) {
      const tagName = match[1].toLowerCase();
      const attrs = match[2] || '';
      const contentStart = match.index + match[0].length;

      const closingTag = new RegExp(`</${tagName}\\s*>`, 'i');
      const closeMatch = closingTag.exec(text.substring(contentStart));
      if (!closeMatch) continue;

      const contentEnd = contentStart + closeMatch.index;

      const langId = this.detectLangId(tagName, attrs);

      regions.push({ langId, contentStart, contentEnd });
    }

    return regions;
  }

  /**
   * Detect the language ID based on the tag name and its attributes.
   */
  private detectLangId(tagName: string, attrs: string): string {
    const langMatch = attrs.match(/\blang\s*=\s*["']([^"']+)["']/);
    const lang = langMatch ? langMatch[1].toLowerCase() : '';

    switch (tagName) {
      case 'template':
        if (lang === 'pug') return 'pug';
        return 'html';
      case 'script':
        if (lang === 'ts' || lang === 'typescript') return 'typescript';
        if (lang === 'tsx') return 'typescriptreact';
        if (lang === 'jsx') return 'javascriptreact';
        return 'javascript';
      case 'style':
        if (lang === 'scss') return 'scss';
        if (lang === 'sass') return 'sass';
        if (lang === 'less') return 'less';
        if (lang === 'stylus' || lang === 'styl') return 'stylus';
        return 'css';
      default:
        return 'plaintext';
    }
  }

  /**
   * Map language ID to file extension for virtual document URI.
   */
  private langIdToExt(langId: string): string {
    const map: Record<string, string> = {
      'html': '.html',
      'javascript': '.js',
      'typescript': '.ts',
      'typescriptreact': '.tsx',
      'javascriptreact': '.jsx',
      'css': '.css',
      'scss': '.scss',
      'sass': '.sass',
      'less': '.less',
      'pug': '.pug',
    };
    return map[langId] || '.txt';
  }
}
