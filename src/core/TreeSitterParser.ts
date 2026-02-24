import Parser from 'web-tree-sitter';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../extension';
import { context } from '../share';

// Map of language ID to WASM file name
const LANG_WASM_MAP: Record<string, string> = {
    'javascript': 'tree-sitter-javascript.wasm',
    'typescript': 'tree-sitter-typescript.wasm',
    'typescriptreact': 'tree-sitter-tsx.wasm',
};

// Regex to extract <script> or <script lang="ts"/"tsx"> content from Vue SFC
const VUE_SCRIPT_RE = /<script(?:\s+[^>]*)?>([^]*?)<\/script>/i;

export class TreeSitterParser {
    private static instance: TreeSitterParser;
    private parsers: Map<string, Parser> = new Map();
    private languages: Map<string, Parser.Language> = new Map();
    private importQueries: Map<string, Parser.Query> = new Map();
    private wasmDir: string;
    private initialized = false;

    private constructor(wasmDir: string) {
        this.wasmDir = wasmDir;
    }

    public static getInstance(contextOrPath?: string): TreeSitterParser {
        if (!TreeSitterParser.instance) {
             // Use extension context path if available, otherwise fall back to provided path
             let wasmPath = contextOrPath;
             if (!wasmPath && context?.extensionPath) {
                 wasmPath = path.join(context.extensionPath, 'src', 'grammars');
             }
             if (!wasmPath) {
                 // Last resort fallback (may not work in bundled extension)
                 wasmPath = path.join(__dirname, '../grammars');
             }
             TreeSitterParser.instance = new TreeSitterParser(wasmPath);
        }
        return TreeSitterParser.instance;
    }

    public async init(): Promise<void> {
        if (this.initialized) return;

        try {
            const treeSitterWasmPath = path.join(this.wasmDir, '..', '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
            log.appendLine(`TreeSitter wasmDir: ${this.wasmDir}`);
            log.appendLine(`TreeSitter wasm path: ${treeSitterWasmPath}`);
            log.appendLine(`TreeSitter wasm exists: ${fs.existsSync(treeSitterWasmPath)}`);

            log.appendLine('Step 1: About to call Parser.init()');
            try {
                await Parser.init({
                    locateFile(scriptName: string) {
                        log.appendLine(`locateFile called with: ${scriptName}`);
                        return treeSitterWasmPath;
                    }
                } as any);
                log.appendLine('Step 2: Parser.init() completed');
            } catch (initErr: any) {
                log.appendLine(`Parser.init() failed: ${initErr.message}`);
                log.appendLine(`Stack: ${initErr.stack}`);
                throw initErr;
            }
            log.appendLine('Tree-sitter initialized');
            this.initialized = true;
        } catch (e: any) {
            log.appendLine(`Failed to initialize tree-sitter: ${e.message}`);
            throw e;
        }
    }

    public async getParser(langId: string): Promise<Parser | undefined> {
        if (!this.initialized) await this.init();

        if (this.parsers.has(langId)) {
            return this.parsers.get(langId);
        }

        const wasmFile = LANG_WASM_MAP[langId];
        if (!wasmFile) {
            return undefined;
        }

        const wasmPath = path.join(this.wasmDir, wasmFile);
        if (!fs.existsSync(wasmPath)) {
            log.appendLine(`WASM file not found: ${wasmPath}`);
            return undefined;
        }

        try {
            log.appendLine(`Loading language WASM: ${wasmPath}`);
            const wasmBinary = fs.readFileSync(wasmPath);
            log.appendLine(`WASM binary size: ${wasmBinary.length}`);
            const lang = await Parser.Language.load(new Uint8Array(wasmBinary));
            log.appendLine(`Language loaded for ${langId}`);
            const parser = new Parser();
            parser.setLanguage(lang);

            this.languages.set(langId, lang);
            this.parsers.set(langId, parser);

            return parser;
        } catch (e: any) {
            log.appendLine(`Failed to load parser for ${langId}: ${e.message || e}`);
            log.appendLine(`Error stack: ${e.stack}`);
            return undefined;
        }
    }

    public getLanguage(langId: string): Parser.Language | undefined {
        return this.languages.get(langId);
    }

    public async extractImports(content: string, filePath: string): Promise<string[]> {
        const langId = this.getLangId(filePath);
        if (!langId) return [];

        // Handle Vue specially: extract script content via regex and parse as TS
        if (langId === 'vue') {
            const scriptContent = this.extractVueScript(content);
            if (scriptContent) {
                return this.extractImports(scriptContent, 'foo.tsx');
            }
            return [];
        }

        const parser = await this.getParser(langId);
        if (!parser) return [];

        const tree = parser.parse(content);
        if (!tree) return [];

        const imports = this.queryImports(tree, langId);
        tree.delete();
        return imports;
    }

    public getLangId(filePath: string): string | undefined {
        if (filePath.endsWith('.ts')) return 'typescript';
        if (filePath.endsWith('.tsx')) return 'typescriptreact';
        if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript';
        if (filePath.endsWith('.vue')) return 'vue';
        return undefined;
    }

    private extractVueScript(content: string): string | null {
        const match = VUE_SCRIPT_RE.exec(content);
        return match ? match[1] : null;
    }

    public extractVueScriptInfo(content: string): { scriptContent: string; scriptOffset: number } | null {
        const match = VUE_SCRIPT_RE.exec(content);
        if (!match) return null;
        return {
            scriptContent: match[1],
            scriptOffset: match.index + match[0].indexOf(match[1]),
        };
    }

    private getImportQuery(langId: string): Parser.Query | null {
        const cached = this.importQueries.get(langId);
        if (cached) return cached;

        const language = this.languages.get(langId);
        if (!language) return null;

        const queryString = `
            (import_statement source: (string) @source)
            (export_statement source: (string) @source)
            (call_expression
                function: (identifier) @func
                arguments: (arguments (string) @source)
                (#eq? @func "require")
            )
            (call_expression
                function: (import)
                arguments: (arguments (string) @source)
            )
        `;

        try {
            const query = language.query(queryString);
            this.importQueries.set(langId, query);
            return query;
        } catch (e) {
            log.appendLine(`Failed to create query for ${langId}: ${e}`);
            return null;
        }
    }

    private queryImports(tree: any, langId: string): string[] {
        const query = this.getImportQuery(langId);
        if (!query) return [];

        const matches = query.matches(tree.rootNode);
        const imports: string[] = [];

        for (const match of matches) {
            for (const capture of match.captures) {
                if (capture.name === 'source') {
                    const text = capture.node.text;
                    if (text.length >= 2) {
                        imports.push(text.substring(1, text.length - 1));
                    }
                }
            }
        }

        return imports;
    }

    /**
     * Find Vue Options definition (data/methods/computed/props) in a .vue file
     * Returns the absolute offset range in the original Vue file
     */
    public async findVueOptionDefinition(
        content: string,
        targetWord: string
    ): Promise<{ start: number; end: number } | null> {
        const scriptInfo = this.extractVueScriptInfo(content);
        if (!scriptInfo) return null;

        const { scriptContent, scriptOffset } = scriptInfo;

        const tsParser = await this.getParser('typescript');
        if (!tsParser) return null;

        const tsTree = tsParser.parse(scriptContent);
        if (!tsTree) return null;

        try {
            const result = this.findOptionPropertyInTree(tsTree, targetWord);
            if (result) {
                return {
                    start: scriptOffset + result.start,
                    end: scriptOffset + result.end
                };
            }
        } finally {
            tsTree.delete();
        }

        return null;
    }

    /**
     * Collect all Vue Options API property names from a .vue file.
     * Returns an array of { name, source } where source is 'data' | 'methods' | 'computed' | 'props'.
     */
    public async collectVueOptionProperties(
        content: string
    ): Promise<{ name: string; source: 'data' | 'methods' | 'computed' | 'props' }[]> {
        const scriptInfo = this.extractVueScriptInfo(content);
        if (!scriptInfo) return [];

        const { scriptContent } = scriptInfo;

        const tsParser = await this.getParser('typescript');
        if (!tsParser) return [];

        const tsTree = tsParser.parse(scriptContent);
        if (!tsTree) return [];

        try {
            return this.collectOptionPropertiesInTree(tsTree);
        } finally {
            tsTree.delete();
        }
    }

    /**
     * Traverse the export default object and collect all property names from
     * data(), methods, computed, and props sections.
     */
    private collectOptionPropertiesInTree(
        tree: any
    ): { name: string; source: 'data' | 'methods' | 'computed' | 'props' }[] {
        const root = tree.rootNode;
        const results: { name: string; source: 'data' | 'methods' | 'computed' | 'props' }[] = [];

        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return results;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return results;

        for (const child of objectNode.children) {
            if (child.type === 'pair' || child.type === 'method_definition') {
                const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
                if (!keyNode) continue;

                const keyName = keyNode.text;

                // methods / computed / props: collect all keys from the value object
                if (['methods', 'computed', 'props'].includes(keyName)) {
                    const source = keyName as 'methods' | 'computed' | 'props';
                    const valueNode = child.childForFieldName('value');

                    if (valueNode && valueNode.type === 'object') {
                        this.collectPropertyNames(valueNode, source, results);
                    }

                    // props can be an array: props: ['foo', 'bar']
                    if (keyName === 'props' && valueNode && valueNode.type === 'array') {
                        for (const elem of valueNode.children) {
                            if (elem.type === 'string' || elem.type === 'string_fragment') {
                                const text = elem.text.replace(/^['"`]|['"`]$/g, '');
                                if (text) {
                                    results.push({ name: text, source: 'props' });
                                }
                            }
                        }
                    }
                }

                // data(): collect keys from the return object
                if (keyName === 'data') {
                    const bodyNode = child.childForFieldName('body') ||
                                     child.childForFieldName('value')?.childForFieldName('body');
                    if (bodyNode) {
                        const returnStmt = this.findNodeByType(bodyNode, 'return_statement');
                        if (returnStmt) {
                            const returnObj = this.findNodeByType(returnStmt, 'object');
                            if (returnObj) {
                                this.collectPropertyNames(returnObj, 'data', results);
                            }
                        }
                    }
                }
            }
        }

        return results;
    }

    /**
     * Collect all property/method names from an object literal node.
     */
    private collectPropertyNames(
        objectNode: any,
        source: 'data' | 'methods' | 'computed' | 'props',
        results: { name: string; source: typeof source }[]
    ): void {
        for (const child of objectNode.children) {
            if (child.type === 'pair' || child.type === 'method_definition') {
                const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
                if (keyNode) {
                    results.push({ name: keyNode.text, source });
                }
            } else if (child.type === 'shorthand_property_identifier') {
                results.push({ name: child.text, source });
            }
        }
    }

    // (removed - replaced by extractVueScriptInfo)

    private findOptionPropertyInTree(tree: any, targetWord: string): { start: number; end: number } | null {
        const root = tree.rootNode;

        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return null;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return null;

        for (const child of objectNode.children) {
            if (child.type === 'pair' || child.type === 'method_definition') {
                const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
                if (!keyNode) continue;

                const keyName = keyNode.text;

                if (['methods', 'computed', 'props'].includes(keyName)) {
                    const valueNode = child.childForFieldName('value');
                    if (valueNode && valueNode.type === 'object') {
                        const found = this.findPropertyInObject(valueNode, targetWord);
                        if (found) return found;
                    }
                }

                if (keyName === 'data') {
                    const bodyNode = child.childForFieldName('body') ||
                                     child.childForFieldName('value')?.childForFieldName('body');
                    if (bodyNode) {
                        const returnStmt = this.findNodeByType(bodyNode, 'return_statement');
                        if (returnStmt) {
                            const returnObj = this.findNodeByType(returnStmt, 'object');
                            if (returnObj) {
                                const found = this.findPropertyInObject(returnObj, targetWord);
                                if (found) return found;
                            }
                        }
                    }
                }
            }
        }

        return null;
    }

    private findPropertyInObject(objectNode: any, targetWord: string): { start: number; end: number } | null {
        for (const child of objectNode.children) {
            if (child.type === 'pair' || child.type === 'method_definition' || child.type === 'shorthand_property_identifier') {
                let keyNode = child.childForFieldName('key') || child.childForFieldName('name');

                if (child.type === 'shorthand_property_identifier') {
                    if (child.text === targetWord) {
                        return { start: child.startIndex, end: child.endIndex };
                    }
                    continue;
                }

                if (keyNode && keyNode.text === targetWord) {
                    return { start: child.startIndex, end: child.endIndex };
                }
            }
        }
        return null;
    }

    private findNodeByType(node: any, type: string): any {
        if (node.type === type) return node;
        for (const child of node.children) {
            const found = this.findNodeByType(child, type);
            if (found) return found;
        }
        return null;
    }

    public async findImportSourceAtPosition(
        content: string,
        filePath: string,
        offset: number
    ): Promise<string | null> {
        const langId = this.getLangId(filePath);
        if (!langId) return null;

        if (langId === 'vue') {
            const scriptInfo = this.extractVueScriptInfo(content);
            if (!scriptInfo) return null;

            const { scriptContent, scriptOffset } = scriptInfo;

            if (offset >= scriptOffset && offset < scriptOffset + scriptContent.length) {
                const relativeOffset = offset - scriptOffset;
                return this.findImportSourceAtPosition(scriptContent, 'temp.ts', relativeOffset);
            }
            return null;
        }

        const parser = await this.getParser(langId);
        if (!parser) return null;

        const tree = parser.parse(content);
        if (!tree) return null;

        try {
            const node = tree.rootNode.descendantForIndex(offset);
            if (!node) return null;

            if (node.type === 'string_fragment' || node.type === 'string') {
                let current = node;
                while (current) {
                    if (current.type === 'import_statement' ||
                        current.type === 'export_statement' ||
                        (current.type === 'call_expression' &&
                         current.childForFieldName('function')?.text === 'require')) {
                        const text = node.type === 'string_fragment' ? node.text :
                                     node.text.substring(1, node.text.length - 1);
                        return text;
                    }
                    current.parent && (current = current.parent);
                }
            }
        } finally {
            tree.delete();
        }

        return null;
    }

    public async findImportPathForIdentifier(
        content: string,
        filePath: string,
        identifier: string
    ): Promise<string | null> {
        const langId = this.getLangId(filePath);
        if (!langId) return null;

        if (langId === 'vue') {
            const scriptInfo = this.extractVueScriptInfo(content);
            if (!scriptInfo) return null;

            return this.findImportPathForIdentifier(scriptInfo.scriptContent, 'temp.ts', identifier);
        }

        const parser = await this.getParser(langId);
        if (!parser) return null;

        const tree = parser.parse(content);
        if (!tree) return null;

        try {
            const language = this.languages.get(langId);
            if (!language) return null;

            const queryString = `
                (import_statement
                    (import_clause
                        (identifier) @default_import
                    )
                    source: (string) @source
                )
                (import_statement
                    (import_clause
                        (named_imports
                            (import_specifier
                                name: (identifier) @named_import
                            )
                        )
                    )
                    source: (string) @source
                )
            `;

            let query: Parser.Query;
            try {
                query = language.query(queryString);
            } catch (e) {
                log.appendLine(`Failed to create import query: ${e}`);
                return null;
            }

            const matches = query.matches(tree.rootNode);

            for (const match of matches) {
                let foundIdentifier = false;
                let sourcePath: string | null = null;

                for (const capture of match.captures) {
                    if ((capture.name === 'default_import' || capture.name === 'named_import') &&
                        capture.node.text === identifier) {
                        foundIdentifier = true;
                    }
                    if (capture.name === 'source') {
                        const text = capture.node.text;
                        sourcePath = text.substring(1, text.length - 1);
                    }
                }

                if (foundIdentifier && sourcePath) {
                    query.delete();
                    return sourcePath;
                }
            }
            query.delete();
        } finally {
            tree.delete();
        }

        return null;
    }
}
