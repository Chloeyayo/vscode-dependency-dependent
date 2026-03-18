import * as vscode from "vscode";
import {
  getCSSLanguageService,
  getSCSSLanguageService,
  getLESSLanguageService,
  TextDocument as CSSTextDocument,
  LanguageService as CSSLanguageService,
  CompletionList as CSSCompletionList,
  Position as CSSPosition,
  CompletionItemKind as CSSCompletionItemKind,
  Stylesheet,
} from "vscode-css-languageservice";
import { InsertReplaceEdit } from "vscode-languageserver-types";

interface CachedRegions {
  uri: string;
  version: number;
  regions: StyleRegion[];
  lineRanges: { startLine: number; endLine: number }[];
}

/**
 * Style region info extracted from a Vue SFC.
 */
interface StyleRegion {
  /** Language id: css, scss, less, etc. */
  langId: string;
  /** Offset of the first char of style content (after the opening tag's >) */
  contentStart: number;
  /** Offset just past the last char of style content (before </style>) */
  contentEnd: number;
}

/**
 * Map CSS language service CompletionItemKind → VS Code CompletionItemKind.
 */
function mapCompletionItemKind(
  kind: CSSCompletionItemKind | undefined
): vscode.CompletionItemKind {
  if (kind === undefined) return vscode.CompletionItemKind.Property;
  switch (kind) {
    case CSSCompletionItemKind.Property:
      return vscode.CompletionItemKind.Property;
    case CSSCompletionItemKind.Value:
      return vscode.CompletionItemKind.Value;
    case CSSCompletionItemKind.Unit:
      return vscode.CompletionItemKind.Unit;
    case CSSCompletionItemKind.Keyword:
      return vscode.CompletionItemKind.Keyword;
    case CSSCompletionItemKind.Snippet:
      return vscode.CompletionItemKind.Snippet;
    case CSSCompletionItemKind.Color:
      return vscode.CompletionItemKind.Color;
    case CSSCompletionItemKind.Reference:
      return vscode.CompletionItemKind.Reference;
    case CSSCompletionItemKind.Function:
      return vscode.CompletionItemKind.Function;
    case CSSCompletionItemKind.Variable:
      return vscode.CompletionItemKind.Variable;
    case CSSCompletionItemKind.Text:
      return vscode.CompletionItemKind.Text;
    case CSSCompletionItemKind.Module:
      return vscode.CompletionItemKind.Module;
    case CSSCompletionItemKind.Class:
      return vscode.CompletionItemKind.Class;
    default:
      return vscode.CompletionItemKind.Property;
  }
}

/**
 * Vue Style Completion Provider
 *
 * Provides CSS/SCSS/Less completions inside <style> blocks in Vue SFCs by
 * using the official `vscode-css-languageservice` package directly.
 *
 * This approach bypasses the unreliable virtual-document + executeCompletionItemProvider
 * pattern (CSS language service doesn't activate for custom-scheme documents) and
 * instead invokes the same CSS engine that powers VS Code's built-in CSS support.
 */
export class VueStyleCompletionProvider
  implements vscode.CompletionItemProvider
{
  private _cssLS?: CSSLanguageService;
  private _scssLS?: CSSLanguageService;
  private _lessLS?: CSSLanguageService;
  private stylesheetCache = new Map<string, Stylesheet>();
  private lastCacheVersion = -1;
  private lastCacheUri = "";
  private regionCache: CachedRegions | null = null;

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList | null> {
    if (!document.fileName.endsWith(".vue")) return null;

    const uri = document.uri.toString();
    const version = document.version;

    // Fast line-range pre-check: skip getText() when cursor is outside all <style> blocks
    const cached = this.regionCache;
    if (cached && cached.uri === uri && cached.version === version) {
      if (!cached.lineRanges.some(r => position.line >= r.startLine && position.line <= r.endLine)) {
        return null;
      }
    }

    const text = document.getText();
    const offset = document.offsetAt(position);

    // Find the style region containing the cursor (cached by uri+version)
    const regions = this.getCachedRegions(uri, version, text, document);
    const region = regions.find(
      (r) => offset > r.contentStart && offset <= r.contentEnd
    );
    if (!region) return null;
    if (token.isCancellationRequested) return null;

    // Select the appropriate language service
    const ls = this.getLanguageService(region.langId);

    // Extract style content and create an in-memory TextDocument for the CSS engine
    const styleContent = text.substring(region.contentStart, region.contentEnd);
    const langIdForDoc = region.langId === "sass" ? "scss" : region.langId;
    const cssDoc = CSSTextDocument.create(
      `embedded://style.${langIdForDoc}`,
      langIdForDoc,
      1,
      styleContent
    );

    // Parse the stylesheet (cached by uri+version+contentStart)
    const stylesheet = this.getStylesheet(ls, cssDoc, uri, version, region.contentStart);

    // Compute the relative position within the extracted style content
    const relativeOffset = offset - region.contentStart;
    const cssPosition = cssDoc.positionAt(relativeOffset);

    // Get completions from the CSS language service
    const cssCompletions: CSSCompletionList = ls.doComplete(
      cssDoc,
      cssPosition,
      stylesheet
    );

    if (!cssCompletions || cssCompletions.items.length === 0) return null;
    if (token.isCancellationRequested) return null;

    // Map CSS-LS completion items to VS Code completion items
    const mappedItems: vscode.CompletionItem[] = cssCompletions.items.map(
      (item) => {
        const vscodeItem = new vscode.CompletionItem(
          item.label,
          mapCompletionItemKind(item.kind)
        );

        // Detail & documentation
        if (item.detail) vscodeItem.detail = item.detail;
        if (item.documentation) {
          vscodeItem.documentation =
            typeof item.documentation === "string"
              ? item.documentation
              : new vscode.MarkdownString(item.documentation.value);
        }

        // Sort text & filter text
        if (item.sortText) vscodeItem.sortText = item.sortText;
        if (item.filterText) vscodeItem.filterText = item.filterText;
        if (item.insertTextFormat === 2) {
          // Snippet format
          const snippetText = item.textEdit
            ? item.textEdit.newText
            : item.insertText ?? item.label;
          vscodeItem.insertText = new vscode.SnippetString(snippetText);
        } else if (item.textEdit) {
          vscodeItem.insertText = item.textEdit.newText;
        } else if (item.insertText) {
          vscodeItem.insertText = item.insertText;
        }

        // Map the text edit range from CSS-doc coordinates back to the Vue document
        if (item.textEdit) {
          const editRange = InsertReplaceEdit.is(item.textEdit)
            ? item.textEdit.replace
            : item.textEdit.range;
          const mappedRange = this.mapCssRangeToVue(
            editRange,
            cssDoc,
            document,
            region.contentStart
          );
          vscodeItem.range = mappedRange;
        }

        // Map additional text edits
        if (item.additionalTextEdits) {
          vscodeItem.additionalTextEdits = item.additionalTextEdits.map(
            (edit) => {
              const mappedRange = this.mapCssRangeToVue(
                edit.range,
                cssDoc,
                document,
                region.contentStart
              );
              return new vscode.TextEdit(mappedRange, edit.newText);
            }
          );
        }

        // Tags (deprecated, etc.)
        if (item.tags) {
          vscodeItem.tags = item.tags.map((t) =>
            t === 1
              ? vscode.CompletionItemTag.Deprecated
              : vscode.CompletionItemTag.Deprecated
          );
        }

        return vscodeItem;
      }
    );

    return new vscode.CompletionList(mappedItems, cssCompletions.isIncomplete);
  }

  /**
   * Map a range from the CSS sub-document coordinates back to the Vue document.
   */
  private mapCssRangeToVue(
    range: { start: CSSPosition; end: CSSPosition },
    cssDoc: { offsetAt: (pos: CSSPosition) => number },
    vueDoc: vscode.TextDocument,
    contentStart: number
  ): vscode.Range {
    const startOffset = cssDoc.offsetAt(range.start) + contentStart;
    const endOffset = cssDoc.offsetAt(range.end) + contentStart;
    return new vscode.Range(
      vueDoc.positionAt(startOffset),
      vueDoc.positionAt(endOffset)
    );
  }

  /**
   * Get the language service for a given language ID.
   */
  private getLanguageService(langId: string): CSSLanguageService {
    switch (langId) {
      case "scss":
      case "sass":
        return (this._scssLS ??= getSCSSLanguageService());
      case "less":
        return (this._lessLS ??= getLESSLanguageService());
      default:
        return (this._cssLS ??= getCSSLanguageService());
    }
  }

  private getStylesheet(
    ls: CSSLanguageService,
    doc: CSSTextDocument,
    uri: string,
    version: number,
    contentStart: number
  ): Stylesheet {
    // Invalidate entire cache when document changes
    if (uri !== this.lastCacheUri || version !== this.lastCacheVersion) {
      this.stylesheetCache.clear();
      this.lastCacheUri = uri;
      this.lastCacheVersion = version;
    }
    const key = String(contentStart);
    let stylesheet = this.stylesheetCache.get(key);
    if (!stylesheet) {
      stylesheet = ls.parseStylesheet(doc);
      this.stylesheetCache.set(key, stylesheet);
    }
    return stylesheet;
  }

  private getCachedRegions(uri: string, version: number, text: string, doc: vscode.TextDocument): StyleRegion[] {
    const c = this.regionCache;
    if (c && c.uri === uri && c.version === version) {
      return c.regions;
    }
    const regions = this.parseStyleRegions(text);
    const lineRanges = regions.map(r => ({
      startLine: doc.positionAt(r.contentStart).line,
      endLine: doc.positionAt(r.contentEnd).line,
    }));
    this.regionCache = { uri, version, regions, lineRanges };
    return regions;
  }

  /**
   * Parse the Vue SFC to find <style> regions.
   */
  private parseStyleRegions(text: string): StyleRegion[] {
    const regions: StyleRegion[] = [];
    const blockPattern = /^<style(\b[^>]*)>/gim;
    const closingRe = /<\/style\s*>/gim;
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(text)) !== null) {
      // Ensure tag is at column 0 (root-level SFC block)
      if (
        match.index > 0 &&
        text[match.index - 1] !== "\n" &&
        text[match.index - 1] !== "\r"
      ) {
        continue;
      }

      const attrs = match[1] || "";
      const contentStart = match.index + match[0].length;

      // Find matching </style> from contentStart
      closingRe.lastIndex = contentStart;
      const closeMatch = closingRe.exec(text);
      if (!closeMatch) continue;

      const contentEnd = closeMatch.index;
      const langId = this.detectLangId(attrs);

      regions.push({ langId, contentStart, contentEnd });
    }

    return regions;
  }

  /**
   * Detect CSS language from style tag attributes.
   */
  private detectLangId(attrs: string): string {
    const langMatch = attrs.match(/\blang\s*=\s*["']([^"']+)["']/);
    const lang = langMatch ? langMatch[1].toLowerCase() : "";

    if (lang === "scss") return "scss";
    if (lang === "sass") return "sass";
    if (lang === "less") return "less";
    if (lang === "stylus" || lang === "styl") return "stylus";
    return "css";
  }
}
