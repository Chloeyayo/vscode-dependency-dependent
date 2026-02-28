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

/**
 * Vue Range Formatting Provider
 * Enables "Format Selection" (Ctrl+K Ctrl+F) in .vue files by:
 *   1. Detecting which SFC region (template/script/style) the selection is in
 *   2. Creating a virtual document in the region's language
 *   3. Delegating to VS Code's built-in formatter for that language
 *   4. Mapping the resulting edits back to the original .vue file
 */
export class VueRangeFormattingProvider implements vscode.DocumentRangeFormattingEditProvider, vscode.DocumentFormattingEditProvider {

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const text = document.getText();
    const regions = this.parseRegions(text);
    const allEdits: vscode.TextEdit[] = [];

    // Format all regions sequentially to accumulate their edits
    for (let i = 0; i < regions.length; i++) {
      if (_token.isCancellationRequested) break;
      const region = regions[i];
      const regionContent = text.substring(region.contentStart, region.contentEnd);
      const ext = this.langIdToExt(region.langId);
      
      try {
        const virtualDoc = await vscode.workspace.openTextDocument({
          language: region.langId,
          content: regionContent,
        });

        // Use format range provider for the whole virtual document content
        const virtualRange = new vscode.Range(
          virtualDoc.positionAt(0),
          virtualDoc.positionAt(regionContent.length)
        );

        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
          'vscode.executeFormatRangeProvider',
          virtualDoc.uri,
          virtualRange,
          options
        );

        if (edits && edits.length > 0) {
          const mappedEdits = edits.map(edit => {
            const origStartOffset = region.contentStart + virtualDoc.offsetAt(edit.range.start);
            const origEndOffset = region.contentStart + virtualDoc.offsetAt(edit.range.end);
            const origRange = new vscode.Range(
              document.positionAt(origStartOffset),
              document.positionAt(origEndOffset)
            );
            return new vscode.TextEdit(origRange, edit.newText);
          });
          allEdits.push(...mappedEdits);
        }
      } catch (e) {
        // Continue to the next region if one fails
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

    // Find which region the selection is entirely within
    const region = regions.find(
      r => startOffset >= r.contentStart && endOffset <= r.contentEnd
    );

    if (!region) {
      // Selection crosses region boundaries or is outside any region
      return [];
    }

    if (_token.isCancellationRequested) return [];
    const regionContent = text.substring(region.contentStart, region.contentEnd);

    // Calculate the selection range relative to the region content
    const relativeStartOffset = startOffset - region.contentStart;
    const relativeEndOffset = endOffset - region.contentStart;

    // Create a virtual document URI with the appropriate language extension
    const ext = this.langIdToExt(region.langId);
    const virtualUri = vscode.Uri.parse(
      `untitled:${document.uri.fsPath}.format-selection${ext}`
    );

    try {
      // Create and show the virtual document (hidden)
      const virtualDoc = await vscode.workspace.openTextDocument({
        language: region.langId,
        content: regionContent,
      });

      // Calculate the range in the virtual document
      const virtualStart = virtualDoc.positionAt(relativeStartOffset);
      const virtualEnd = virtualDoc.positionAt(relativeEndOffset);
      const virtualRange = new vscode.Range(virtualStart, virtualEnd);

      // Execute the built-in format range command on the virtual document
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatRangeProvider',
        virtualDoc.uri,
        virtualRange,
        options
      );

      if (!edits || edits.length === 0) return [];

      // Map edits from virtual document positions back to the original .vue file
      const mappedEdits: vscode.TextEdit[] = edits.map(edit => {
        const origStartOffset = region.contentStart + virtualDoc.offsetAt(edit.range.start);
        const origEndOffset = region.contentStart + virtualDoc.offsetAt(edit.range.end);
        const origRange = new vscode.Range(
          document.positionAt(origStartOffset),
          document.positionAt(origEndOffset)
        );
        return new vscode.TextEdit(origRange, edit.newText);
      });

      return mappedEdits;
    } catch (e) {
      // If formatting fails, return no edits silently
      return [];
    }
  }

  /**
   * Parse the Vue SFC file to find template, script, and style regions.
   */
  private parseRegions(text: string): SFCRegion[] {
    const regions: SFCRegion[] = [];

    // Match <template>, <script>, <style> blocks
    // Pattern: <tag [attrs]> ... </tag>
    const blockPattern = /<(template|script|style)(\b[^>]*)>/gi;
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(text)) !== null) {
      const tagName = match[1].toLowerCase();
      const attrs = match[2] || '';
      const contentStart = match.index + match[0].length;

      // Find the closing tag
      const closingTag = new RegExp(`</${tagName}\\s*>`, 'i');
      const closeMatch = closingTag.exec(text.substring(contentStart));
      if (!closeMatch) continue;

      const contentEnd = contentStart + closeMatch.index;

      // Determine the language from the tag + lang attribute
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
