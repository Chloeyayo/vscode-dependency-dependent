import * as vscode from "vscode";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";

/**
 * SFC region info: the block's content range within the Vue file.
 */
interface SFCRegion {
  /** Tag name: template, script, or style */
  tagName: string;
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
  private readonly documentModels = VueDocumentModelManager.getInstance();
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
    const text = this.documentModels.getDocumentModel(document).text;
    const regions = this.parseRegions(text);
    const allEdits: vscode.TextEdit[] = [];

    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const indent = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";

    for (let i = 0; i < regions.length; i++) {
      if (_token.isCancellationRequested) break;
      const region = regions[i];
      const regionContent = text.substring(region.contentStart, region.contentEnd);

      // Strip leading/trailing whitespace to get pure content for formatting
      const trimmed = regionContent.replace(/^\r?\n/, '').replace(/\r?\n[\t ]*$/, '');

      let virtualDoc: vscode.TextDocument | undefined;
      try {
        virtualDoc = await this.openVirtualDoc(region.langId, trimmed);

        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
          'vscode.executeFormatDocumentProvider',
          virtualDoc.uri,
          options
        );

        // Apply edits to get formatted text
        let formatted = trimmed;
        if (edits && edits.length > 0) {
          formatted = this.applyEditsToString(trimmed, edits, virtualDoc);
        }

        // Only template gets one level of indentation; script/style stay flush
        const needIndent = region.tagName === 'template';
        const indented = formatted
          .split(/\r?\n/)
          .map(line => (needIndent && line.length > 0) ? indent + line : line)
          .join(eol);
        const replacement = eol + indented + eol;

        if (replacement !== regionContent) {
          const origRange = new vscode.Range(
            document.positionAt(region.contentStart),
            document.positionAt(region.contentEnd)
          );
          allEdits.push(new vscode.TextEdit(origRange, replacement));
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
    const text = this.documentModels.getDocumentModel(document).text;
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
   * Only matches root-level blocks (no leading whitespace before the opening tag).
   */
  private parseRegions(text: string): SFCRegion[] {
    const regions: SFCRegion[] = [];

    // Only match tags at column 0 (root-level SFC blocks, not nested <template v-if>)
    const blockPattern = /^<(template|script|style)(\b[^>]*)>/gim;
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(text)) !== null) {
      // Verify tag is truly at column 0 (no leading whitespace on its line)
      if (match.index > 0 && text[match.index - 1] !== '\n' && text[match.index - 1] !== '\r') {
        continue;
      }

      const tagName = match[1].toLowerCase();
      const attrs = match[2] || '';
      const contentStart = match.index + match[0].length;

      // Find the matching root-level closing tag (at column 0)
      const closingRe = new RegExp(`^</${tagName}\\s*>`, 'im');
      const closeMatch = closingRe.exec(text.substring(contentStart));
      if (!closeMatch) continue;

      const contentEnd = contentStart + closeMatch.index;

      const langId = this.detectLangId(tagName, attrs);

      regions.push({ tagName, langId, contentStart, contentEnd });
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

  /**
   * Apply TextEdits to a string, returning the resulting string.
   */
  private applyEditsToString(
    source: string,
    edits: vscode.TextEdit[],
    doc: vscode.TextDocument
  ): string {
    // Sort edits in reverse order so earlier offsets remain valid
    const sorted = [...edits].sort((a, b) => {
      const ao = doc.offsetAt(a.range.start);
      const bo = doc.offsetAt(b.range.start);
      return bo - ao;
    });
    let result = source;
    for (const edit of sorted) {
      const start = doc.offsetAt(edit.range.start);
      const end = doc.offsetAt(edit.range.end);
      result = result.substring(0, start) + edit.newText + result.substring(end);
    }
    return result;
  }
}
