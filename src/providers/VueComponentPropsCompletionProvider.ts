import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ResolverFactory, CachedInputFileSystem } from "enhanced-resolve";
import { DepService } from "../DepService";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";
import { VueTemplateContextService } from "../core/VueTemplateContextService";
import { log } from "../extension";
import { NATIVE_HTML_TAGS } from "../core/htmlTags";

/**
 * Convert kebab-case / snake_case / camelCase tag name to PascalCase
 */
function toPascalCase(name: string): string {
    return name
        .split(/[-_]+/g)
        .filter(Boolean)
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
        .join('');
}


export class VueComponentPropsCompletionProvider implements vscode.CompletionItemProvider {
    private treeSitterParser: TreeSitterParser;
    private documentModels: VueDocumentModelManager;
    private templateContext: VueTemplateContextService;
    private resolver: any;
    private lastWorkspace: string | undefined;

    constructor() {
        this.treeSitterParser = TreeSitterParser.getInstance();
        this.documentModels = VueDocumentModelManager.getInstance();
        this.templateContext = VueTemplateContextService.getInstance();
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | null> {
        if (!document.fileName.endsWith('.vue')) return null;
        if (token.isCancellationRequested) return null;

        const model = this.documentModels.getDocumentModel(document);
        const offset = document.offsetAt(position);
        const tagCtx = this.templateContext.getOpenTagContext(
            model.text,
            offset,
            model.templateBounds,
        );
        if (!tagCtx) return null;

        const { tagName } = tagCtx;
        if (NATIVE_HTML_TAGS.has(tagName.toLowerCase())) return null;

        const pascalName = toPascalCase(tagName);

        // Find import path for this component in the current file
        let importPath: string | null = null;
        try {
            importPath = await this.treeSitterParser.findImportPathForComponentTag(
                model.text,
                document.uri.fsPath,
                tagName,
            );
        } catch (e) {
            log.appendLine(`VueComponentPropsCompletionProvider: findImportPathForComponentTag error: ${e}`);
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

        const props = await this.getComponentProps(absPath, token);
        if (!props.length) return null;

        const usedAttrs = tagCtx.existingAttributes;

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
        const model = await this.documentModels.getFileModel(absPath);
        if (!model || token.isCancellationRequested) {
            return [];
        }

        let allProps: { name: string; source: string }[] = [];
        try {
            allProps = await model.getVueOptionProperties();
        } catch (e) {
            log.appendLine(`VueComponentPropsCompletionProvider: collectVueOptionProperties error: ${e}`);
            return [];
        }

        return allProps.filter(p => p.source === 'props').map(p => p.name);
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
