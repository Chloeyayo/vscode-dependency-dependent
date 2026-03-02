import * as vscode from "vscode";
import * as path from "path";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { log } from "../extension";
import { isOffsetInsideRootTemplate } from "../core/vueTemplateUtils";
import { NATIVE_HTML_TAGS } from "../core/htmlTags";

/**
 * Convert file basename (without extension) to PascalCase component name.
 * e.g. "my-dialog.vue" → "MyDialog", "UserForm.vue" → "UserForm"
 */
function fileNameToComponentName(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath));
    return base
        .replace(/-(\w)/g, (_, c) => c.toUpperCase())
        .replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * Convert PascalCase to kebab-case for filter text.
 * e.g. "MyDialog" → "my-dialog"
 */
function toKebabCase(name: string): string {
    return name
        .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : '-' + c.toLowerCase()));
}

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

function isIgnoredVueFile(uri: vscode.Uri): boolean {
    const normalized = uri.fsPath.replace(/\\/g, '/');
    return normalized.includes('/node_modules/') ||
           normalized.includes('/.git/') ||
           normalized.includes('/dist/') ||
           normalized.includes('/out/');
}

/** Internal data stored on each CompletionItem for use in resolveCompletionItem */
interface ComponentItemData {
    targetPath: string;
    componentName: string;
    documentUri: string;
}

interface WorkspaceVueIndexState {
    files: Map<string, vscode.Uri>;
    initialized: boolean;
    initPromise?: Promise<void>;
    watcher: vscode.FileSystemWatcher;
}

export class VueComponentTagCompletionProvider
    implements vscode.CompletionItemProvider, vscode.Disposable {

    private treeSitterParser: TreeSitterParser;
    private workspaceStates = new Map<string, WorkspaceVueIndexState>();
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.treeSitterParser = TreeSitterParser.getInstance();
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
        this.workspaceStates.clear();
    }

    private getWorkspaceState(workspace: vscode.WorkspaceFolder): WorkspaceVueIndexState {
        const key = workspace.uri.toString();
        const cached = this.workspaceStates.get(key);
        if (cached) {
            return cached;
        }

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspace, '**/*.vue'),
            false,
            false,
            false
        );

        const state: WorkspaceVueIndexState = {
            files: new Map<string, vscode.Uri>(),
            initialized: false,
            watcher,
        };

        watcher.onDidCreate((uri) => {
            if (isIgnoredVueFile(uri)) return;
            const normalized = vscode.Uri.file(uri.fsPath).fsPath;
            state.files.set(normalized, uri);
        });
        watcher.onDidDelete((uri) => {
            const normalized = vscode.Uri.file(uri.fsPath).fsPath;
            state.files.delete(normalized);
        });
        watcher.onDidChange((uri) => {
            if (isIgnoredVueFile(uri)) return;
            const normalized = vscode.Uri.file(uri.fsPath).fsPath;
            if (state.files.has(normalized)) {
                state.files.set(normalized, uri);
            }
        });

        this.disposables.push(watcher);
        this.workspaceStates.set(key, state);
        return state;
    }

    private async ensureWorkspaceIndexed(
        workspace: vscode.WorkspaceFolder,
        state: WorkspaceVueIndexState
    ): Promise<void> {
        if (state.initialized) {
            return;
        }
        if (state.initPromise) {
            return state.initPromise;
        }

        state.initPromise = (async () => {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(workspace, '**/*.vue'),
                '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}'
            );
            for (const file of files) {
                if (isIgnoredVueFile(file)) continue;
                const normalized = vscode.Uri.file(file.fsPath).fsPath;
                state.files.set(normalized, file);
            }
            state.initialized = true;
        })().finally(() => {
            state.initPromise = undefined;
        });

        return state.initPromise;
    }

    private async getVueFiles(documentUri: vscode.Uri): Promise<vscode.Uri[]> {
        const workspace = vscode.workspace.getWorkspaceFolder(documentUri);
        if (!workspace) {
            return [];
        }

        const state = this.getWorkspaceState(workspace);
        await this.ensureWorkspaceIndexed(workspace, state);
        return Array.from(state.files.values());
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList | null> {
        if (!document.fileName.endsWith('.vue')) return null;
        if (!this.isInsideTemplate(document, position)) return null;

        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        // Must be right after a < (with optional partial tag name already typed)
        const tagMatch = textBefore.match(/<([\w-]*)$/);
        if (!tagMatch) return null;

        if (token.isCancellationRequested) return null;

        const partialName = tagMatch[1]; // text already typed after <
        const partialLower = partialName.toLowerCase();

        // Range to replace: just the part already typed (after <)
        const replaceStart = new vscode.Position(position.line, position.character - partialName.length);
        const replaceRange = new vscode.Range(replaceStart, position);

        // Find all .vue files in the workspace (indexed + watcher incremental updates)
        const vueFiles = await this.getVueFiles(document.uri);
        if (token.isCancellationRequested) return null;

        const currentFilePath = document.uri.fsPath;
        const docText = document.getText();

        // Collect already-imported component names to skip
        const importedNames = this.getAlreadyImportedNames(docText);

        const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
        const workspaceRoot = workspace?.uri.fsPath || '';

        const items: vscode.CompletionItem[] = [];

        for (const fileUri of vueFiles) {
            if (token.isCancellationRequested) break;

            const targetPath = fileUri.fsPath;
            if (targetPath === currentFilePath) continue;

            const componentName = fileNameToComponentName(targetPath);
            if (!componentName) continue;

            // Skip native HTML names
            if (NATIVE_HTML_TAGS.has(componentName.toLowerCase())) continue;

            const kebabName = toKebabCase(componentName);
            if (partialLower.length > 0) {
                const matchesPascal = componentName.toLowerCase().startsWith(partialLower);
                const matchesKebab = kebabName.startsWith(partialLower);
                if (!matchesPascal && !matchesKebab) {
                    continue;
                }
            }

            // Show all components (including already-imported ones) — resolveCompletionItem
            // will decide whether to add the import edit or not
            const isAlreadyImported = importedNames.has(componentName);
            const relPath = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');

            const item = new vscode.CompletionItem(componentName, vscode.CompletionItemKind.Module);
            item.detail = relPath;
            item.filterText = componentName + ' ' + kebabName;
            item.insertText = componentName;
            item.range = replaceRange;
            item.sortText = isAlreadyImported ? `1_${componentName}` : `5_${componentName}`;

            if (!isAlreadyImported) {
                item.documentation = new vscode.MarkdownString('Auto-import component');
                // Store data for resolveCompletionItem
                (item as any).data = {
                    targetPath,
                    componentName,
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

            const docText = document.getText();
            const currentFilePath = document.uri.fsPath;

            const workspace = vscode.workspace.getWorkspaceFolder(docUri);
            const workspaceRoot = workspace?.uri.fsPath || '';

            // Compute import path
            const importPathStr = computeImportPath(currentFilePath, targetPath, workspaceRoot);

            // Extract script info (offset within full document)
            const scriptInfo = this.treeSitterParser.extractVueScriptInfo(docText);

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
                // Find end of template block to insert after
                const templateEndMatch = docText.match(/^<\/template\s*>/m);
                if (templateEndMatch && templateEndMatch.index !== undefined) {
                    const insertOffset = templateEndMatch.index + templateEndMatch[0].length;
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

    /**
     * Extract already-imported component names from the document's script section.
     */
    private getAlreadyImportedNames(docText: string): Set<string> {
        const names = new Set<string>();
        // Match: import ComponentName from '...'
        const importRe = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(docText)) !== null) {
            names.add(m[1]);
        }
        return names;
    }

    private isInsideTemplate(document: vscode.TextDocument, position: vscode.Position): boolean {
        return isOffsetInsideRootTemplate(document.getText(), document.offsetAt(position));
    }
}
