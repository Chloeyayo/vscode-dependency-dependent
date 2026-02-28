import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ResolverFactory, CachedInputFileSystem } from "enhanced-resolve";
import { DepService } from "../DepService";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { log } from "../extension";

// Common HTML native elements to exclude from component prop completion
const NATIVE_HTML_TAGS = new Set([
    'div', 'span', 'p', 'a', 'button', 'input', 'form', 'table', 'tr', 'td', 'th',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'video', 'audio',
    'select', 'option', 'optgroup', 'label', 'header', 'footer', 'main', 'section',
    'article', 'nav', 'aside', 'figure', 'figcaption', 'template', 'slot', 'style',
    'script', 'canvas', 'iframe', 'textarea', 'pre', 'code', 'hr', 'br', 'strong',
    'em', 'b', 'i', 'u', 's', 'small', 'big', 'sub', 'sup', 'blockquote', 'q',
    'cite', 'abbr', 'acronym', 'address', 'map', 'area', 'object', 'param', 'embed',
    'fieldset', 'legend', 'caption', 'col', 'colgroup', 'thead', 'tbody', 'tfoot',
    'dd', 'dl', 'dt', 'menu', 'menuitem', 'summary', 'details', 'dialog', 'data',
    'datalist', 'output', 'progress', 'meter', 'time', 'mark', 'ruby', 'rt', 'rp',
    'bdi', 'bdo', 'wbr', 'picture', 'source', 'track', 'noscript', 'html', 'head',
    'body', 'base', 'link', 'meta', 'title', 'keygen', 'del', 'ins', 'svg', 'path',
    'g', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse', 'text', 'use',
    'defs', 'symbol', 'mask', 'clippath', 'filter', 'image', 'pattern', 'radialGradient',
    'linearGradient', 'stop', 'animate', 'animateTransform', 'animateMotion', 'set',
    'transition', 'keep-alive', 'component', 'router-view', 'router-link',
]);

/** djb2 hash for caching */
function hashContent(content: string): number {
    let hash = 5381;
    for (let i = 0, len = content.length; i < len; i++) {
        hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
    }
    return hash;
}

/**
 * Convert kebab-case or camelCase tag name to PascalCase
 */
function toPascalCase(name: string): string {
    return name
        .replace(/-(\w)/g, (_, c) => c.toUpperCase())
        .replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * Scan backwards from offset to find the currently open tag name.
 * Returns null if we're not inside an open tag or the tag is a native HTML element.
 */
function getOpenTagContext(text: string, offset: number): { tagName: string } | null {
    let inQuote: string | null = null;
    for (let i = offset - 1; i >= 0; i--) {
        const ch = text[i];
        if (!inQuote) {
            if (ch === '>') return null;            // Past a closed tag
            if (ch === '<') {
                if (text[i + 1] === '/') return null; // Closing tag </tag>
                const rest = text.slice(i + 1);
                const m = rest.match(/^([\w-]+)/);
                return m ? { tagName: m[1] } : null;
            }
            if (ch === '"' || ch === "'") {
                inQuote = ch;
            }
        } else {
            if (ch === inQuote) inQuote = null;
        }
    }
    return null;
}

/**
 * Extract the existing attribute names already used on the current open tag.
 * Scans forward from the < of the current tag to the cursor.
 */
function getExistingAttributes(text: string, offset: number): Set<string> {
    const attrs = new Set<string>();
    // Find the opening < of the current tag
    let inQuote: string | null = null;
    let tagStart = -1;
    for (let i = offset - 1; i >= 0; i--) {
        const ch = text[i];
        if (!inQuote) {
            if (ch === '>') break;
            if (ch === '<') { tagStart = i; break; }
            if (ch === '"' || ch === "'") inQuote = ch;
        } else {
            if (ch === inQuote) inQuote = null;
        }
    }
    if (tagStart === -1) return attrs;

    // Scan the tag content from tagStart to offset
    const tagText = text.slice(tagStart, offset);
    // Match attribute names: word before = or standalone (including :attr and @attr)
    const attrRe = /(?:^|\s)([:@]?[\w-]+)\s*(?:=|(?=\s|$|>|\/))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tagText)) !== null) {
        const attrName = m[1].replace(/^[:@]/, ''); // strip : or @ prefix
        attrs.add(attrName);
    }
    return attrs;
}

export class VueComponentPropsCompletionProvider implements vscode.CompletionItemProvider {
    private treeSitterParser: TreeSitterParser;
    private resolver: any;
    private lastWorkspace: string | undefined;
    // Cache: abs path → { hash, props }
    private propsCache: Map<string, { hash: number; props: string[] }> = new Map();

    constructor() {
        this.treeSitterParser = TreeSitterParser.getInstance();
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | null> {
        if (!document.fileName.endsWith('.vue')) return null;
        if (!this.isInsideTemplate(document, position)) return null;
        if (token.isCancellationRequested) return null;

        const text = document.getText();
        const offset = document.offsetAt(position);

        const tagCtx = getOpenTagContext(text, offset);
        if (!tagCtx) return null;

        const { tagName } = tagCtx;
        if (NATIVE_HTML_TAGS.has(tagName.toLowerCase())) return null;

        const pascalName = toPascalCase(tagName);

        // Find import path for this component in the current file
        let importPath: string | null = null;
        try {
            importPath = await this.treeSitterParser.findImportPathForIdentifier(text, document.uri.fsPath, pascalName);
        } catch (e) {
            log.appendLine(`VueComponentPropsCompletionProvider: findImportPathForIdentifier error: ${e}`);
        }

        if (!importPath) return null;

        const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspace) return null;

        if (!this.resolver || this.lastWorkspace !== workspace.uri.fsPath) {
            await this.initResolver(workspace);
        }
        if (!this.resolver) return null;
        if (token.isCancellationRequested) return null;

        // Resolve importPath to an absolute file path
        let absPath: string;
        try {
            absPath = await new Promise<string>((resolve, reject) => {
                this.resolver.resolve(
                    {},
                    path.dirname(document.uri.fsPath),
                    importPath!,
                    {},
                    (err: any, filepath: string) => {
                        if (err) reject(err);
                        else resolve(filepath);
                    }
                );
            });
        } catch (e) {
            log.appendLine(`VueComponentPropsCompletionProvider: resolve error: ${e}`);
            return null;
        }

        if (!absPath || !fs.existsSync(absPath)) return null;
        if (token.isCancellationRequested) return null;

        // Read + parse component file with caching
        const props = await this.getComponentProps(absPath, token);
        if (!props.length) return null;

        // Filter out already-used attributes
        const usedAttrs = getExistingAttributes(text, offset);

        const items: vscode.CompletionItem[] = [];
        for (const propName of props) {
            if (usedAttrs.has(propName)) continue;
            const item = new vscode.CompletionItem(propName, vscode.CompletionItemKind.Property);
            item.insertText = new vscode.SnippetString(`:${propName}="$1"`);
            item.detail = '(prop)';
            item.sortText = `0_${propName}`;
            item.documentation = new vscode.MarkdownString(`**${pascalName}** prop`);
            items.push(item);
        }

        return new vscode.CompletionList(items, false);
    }

    private async getComponentProps(absPath: string, token: vscode.CancellationToken): Promise<string[]> {
        let fileContent: string;
        try {
            fileContent = fs.readFileSync(absPath, 'utf-8');
        } catch {
            return [];
        }

        const hash = hashContent(fileContent);
        const cached = this.propsCache.get(absPath);
        if (cached && cached.hash === hash) {
            return cached.props;
        }

        if (token.isCancellationRequested) return [];

        let allProps: { name: string; source: string }[] = [];
        try {
            allProps = await this.treeSitterParser.collectVueOptionProperties(fileContent);
        } catch (e) {
            log.appendLine(`VueComponentPropsCompletionProvider: collectVueOptionProperties error: ${e}`);
            return [];
        }

        const props = allProps.filter(p => p.source === 'props').map(p => p.name);
        this.propsCache.set(absPath, { hash, props });
        return props;
    }

    private isInsideTemplate(document: vscode.TextDocument, position: vscode.Position): boolean {
        const text = document.getText();
        const offset = document.offsetAt(position);

        const templateStart = text.match(/^<template[\s>]/m);
        if (!templateStart || templateStart.index === undefined) return false;

        const openTagEnd = text.indexOf('>', templateStart.index);
        if (openTagEnd === -1 || offset <= openTagEnd) return false;

        const templateEndMatch = text.match(/^<\/template\s*>/m);
        if (!templateEndMatch || templateEndMatch.index === undefined) return false;

        return offset > openTagEnd && offset < templateEndMatch.index;
    }

    private async initResolver(workspace: vscode.WorkspaceFolder) {
        this.lastWorkspace = workspace.uri.fsPath;

        if (this.resolver?.fileSystem?.purge) {
            this.resolver.fileSystem.purge();
        }

        const webpackConfigFn = await DepService.getWebpackConfigFn();
        let resolveConfig: any = {
            extensions: [".js", ".jsx", ".ts", ".tsx", ".vue", ".json"],
            alias: {},
        };

        if (typeof webpackConfigFn === "function") {
            try {
                const dummyConfig = { resolve: { alias: {}, extensions: [] } };
                const result = webpackConfigFn(dummyConfig);
                if (result && result.resolve) {
                    resolveConfig = {
                        ...resolveConfig,
                        ...result.resolve,
                        extensions: result.resolve.extensions || resolveConfig.extensions,
                        alias: result.resolve.alias || resolveConfig.alias,
                    };
                }
            } catch (e) {
                log.appendLine(`VueComponentPropsCompletionProvider: webpack config error: ${e}`);
            }
        }

        if (!resolveConfig.alias || Object.keys(resolveConfig.alias).length === 0) {
            resolveConfig.alias = {
                "@": path.join(workspace.uri.fsPath, "src"),
            };
        }

        this.resolver = ResolverFactory.createResolver({
            fileSystem: new CachedInputFileSystem(fs as any, 4000),
            extensions: resolveConfig.extensions,
            alias: resolveConfig.alias,
            modules: resolveConfig.modules || ["node_modules"],
            preferRelative: true,
        });
    }
}
