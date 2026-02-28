import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { log } from "../extension";

// Reuse the same native HTML tags set to avoid showing auto-import for them
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
    'defs', 'symbol', 'mask', 'clippath', 'filter', 'image', 'pattern',
    'transition', 'keep-alive', 'component', 'router-view', 'router-link',
]);

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

/** Internal data stored on each CompletionItem for use in resolveCompletionItem */
interface ComponentItemData {
    targetPath: string;
    componentName: string;
    documentUri: string;
}

export class VueComponentTagCompletionProvider
    implements vscode.CompletionItemProvider {

    private treeSitterParser: TreeSitterParser;

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

        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        // Must be right after a < (with optional partial tag name already typed)
        const tagMatch = textBefore.match(/<([\w-]*)$/);
        if (!tagMatch) return null;

        if (token.isCancellationRequested) return null;

        const partialName = tagMatch[1]; // text already typed after <

        // Range to replace: just the part already typed (after <)
        const replaceStart = new vscode.Position(position.line, position.character - partialName.length);
        const replaceRange = new vscode.Range(replaceStart, position);

        // Find all .vue files in the workspace
        const vueFiles = await vscode.workspace.findFiles(
            '**/*.vue',
            '{**/node_modules/**,**/.git/**}'
        );

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

            // Show all components (including already-imported ones) — resolveCompletionItem
            // will decide whether to add the import edit or not
            const isAlreadyImported = importedNames.has(componentName);

            const relPath = path.relative(workspaceRoot, targetPath).replace(/\\/g, '/');
            const kebabName = toKebabCase(componentName);

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
}
