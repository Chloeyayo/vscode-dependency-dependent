import * as vscode from "vscode";
import * as path from "path";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";
import { VueTemplateContextService } from "../core/VueTemplateContextService";
import { VueWorkspaceComponentIndexService } from "../core/VueWorkspaceComponentIndexService";
import { log } from "../extension";

/**
 * Compute the import path to use when importing targetFile from currentFile.
 * Prefers @/ alias if target is under src/, otherwise uses relative path.
 */
function computeImportPath(currentFile: string, targetFile: string, workspaceRoot: string): string {
    const srcDir = path.join(workspaceRoot, 'src');
    const normalizedTarget = targetFile.replace(/\\/g, '/');
    const normalizedSrc = srcDir.replace(/\\/g, '/');

    if (normalizedTarget.startsWith(normalizedSrc + '/')) {
        return '@/' + path.relative(srcDir, targetFile).replace(/\\/g, '/');
    }
    const rel = path.relative(path.dirname(currentFile), targetFile).replace(/\\/g, '/');
    return rel.startsWith('.') ? rel : './' + rel;
}

/** Internal data stored on each CompletionItem for use in resolveCompletionItem */
interface ComponentItemData {
    targetPath: string;
    componentName: string;
    documentUri: string;
}

export class VueComponentTagCompletionProvider
    implements vscode.CompletionItemProvider, vscode.Disposable {

    private treeSitterParser: TreeSitterParser;
    private documentModels: VueDocumentModelManager;
    private templateContext: VueTemplateContextService;
    private workspaceComponentIndex: VueWorkspaceComponentIndexService;

    constructor() {
        this.treeSitterParser = TreeSitterParser.getInstance();
        this.documentModels = VueDocumentModelManager.getInstance();
        this.templateContext = VueTemplateContextService.getInstance();
        this.workspaceComponentIndex = new VueWorkspaceComponentIndexService();
    }

    public dispose(): void {
        this.workspaceComponentIndex.dispose();
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | null> {
        if (!document.fileName.endsWith('.vue')) return null;
        const model = this.documentModels.getDocumentModel(document);
        if (!this.templateContext.isInsideRootTemplate(model.templateBounds, document.offsetAt(position))) {
            return null;
        }

        if (token.isCancellationRequested) return null;

        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);
        const tagCompletion = this.templateContext.getTagNameCompletionContext(
            textBefore,
            position.character,
        );
        if (!tagCompletion) return null;

        const partialName = tagCompletion.partialName;
        const partialLower = partialName.toLowerCase();

        // Range to replace: just the part already typed (after <)
        const replaceStart = new vscode.Position(position.line, tagCompletion.replaceStartCharacter);
        const replaceRange = new vscode.Range(replaceStart, position);

        const components = await this.workspaceComponentIndex.getComponents(document.uri);
        if (token.isCancellationRequested) return null;

        const currentFilePath = document.uri.fsPath;
        const importedNames = model.importedComponentNames;

        const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
        const workspaceRoot = workspace?.uri.fsPath || '';

        const items: vscode.CompletionItem[] = [];

        for (const comp of components) {
            if (token.isCancellationRequested) break;

            const targetPath = comp.uri.fsPath;
            if (targetPath === currentFilePath) continue;

            if (partialLower.length > 0) {
                if (!comp.nameLower.startsWith(partialLower) && !comp.kebabLower.startsWith(partialLower)) {
                    continue;
                }
            }

            const isAlreadyImported = importedNames.has(comp.componentName);
            const relPath = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');

            const item = new vscode.CompletionItem(comp.componentName, vscode.CompletionItemKind.Module);
            item.detail = relPath;
            item.filterText = comp.componentName + ' ' + comp.kebabName;
            item.insertText = comp.componentName;
            item.range = replaceRange;
            item.sortText = isAlreadyImported ? `1_${comp.componentName}` : `5_${comp.componentName}`;

            if (!isAlreadyImported) {
                item.documentation = new vscode.MarkdownString('Auto-import component');
                // Store data for resolveCompletionItem
                (item as any).data = {
                    targetPath,
                    componentName: comp.componentName,
                    documentUri: document.uri.toString(),
                } as ComponentItemData;
            }

            items.push(item);
        }

        // Use incomplete list so VS Code continues filtering
        return new vscode.CompletionList(items, true);
    }

    async resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem> {
        const data: ComponentItemData | undefined = (item as any).data;
        if (!data) return item;

        const { targetPath, componentName, documentUri } = data;

        try {
            const docUri = vscode.Uri.parse(documentUri);
            const document = await vscode.workspace.openTextDocument(docUri);
            if (token.isCancellationRequested) return item;

            const model = this.documentModels.getDocumentModel(document);
            const currentFilePath = document.uri.fsPath;

            const workspace = vscode.workspace.getWorkspaceFolder(docUri);
            const workspaceRoot = workspace?.uri.fsPath || '';

            // Compute import path
            const importPathStr = computeImportPath(currentFilePath, targetPath, workspaceRoot);

            // Extract script info (offset within full document)
            const scriptInfo = model.scriptInfo;

            const edits: vscode.TextEdit[] = [];

            if (scriptInfo) {
                const { scriptContent, scriptOffset } = scriptInfo;

                // --- Edit 1: Add import statement ---
                const lastImportEnd = await this.treeSitterParser.findLastImportEndOffset(scriptContent);
                if (token.isCancellationRequested) return item;

                // Insert position in the full document
                const importInsertOffset = scriptOffset + lastImportEnd;
                const importInsertPos = document.positionAt(importInsertOffset);
                const importLine = `\nimport ${componentName} from '${importPathStr}';`;
                edits.push(vscode.TextEdit.insert(importInsertPos, importLine));

                // --- Edit 2: Register in components ---
                const componentsInfo = await this.treeSitterParser.findComponentsInsertInfo(scriptContent);
                if (token.isCancellationRequested) return item;

                if (componentsInfo) {
                    const compInsertOffset = scriptOffset + componentsInfo.insertOffset;
                    const compInsertPos = document.positionAt(compInsertOffset);

                    if (componentsInfo.type === 'existing') {
                        // Insert "ComponentName," before the closing }
                        // Check if the components object is empty or has existing entries
                        const beforeClose = scriptContent.slice(0, componentsInfo.insertOffset);
                        const objectOpenIdx = beforeClose.lastIndexOf('{');
                        const between = beforeClose.slice(objectOpenIdx + 1).trim();
                        const needsLeadingComma = between.length > 0 && !between.endsWith(',');
                        const insertStr = needsLeadingComma
                            ? `, ${componentName}`
                            : ` ${componentName} `;
                        edits.push(vscode.TextEdit.insert(compInsertPos, insertStr));
                    } else {
                        // Insert "\n  components: { ComponentName }," after the opening {
                        const insertStr = `\n  components: { ${componentName} },`;
                        edits.push(vscode.TextEdit.insert(compInsertPos, insertStr));
                    }
                }
            } else {
                // No script block found — add a basic <script> with import + export default
                const templateBounds = model.templateBounds;
                if (templateBounds) {
                    const insertOffset = templateBounds.closeTagEnd + 1;
                    const insertPos = document.positionAt(insertOffset);
                    const scriptBlock = `\n\n<script>\nimport ${componentName} from '${importPathStr}';\n\nexport default {\n  components: { ${componentName} },\n};\n</script>`;
                    edits.push(vscode.TextEdit.insert(insertPos, scriptBlock));
                }
            }

            if (edits.length > 0) {
                item.additionalTextEdits = edits;
            }
        } catch (e) {
            log.appendLine(`VueComponentTagCompletionProvider resolveCompletionItem error: ${e}`);
        }

        return item;
    }
}
