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
    private identifierImportQuery: Map<string, Parser.Query> = new Map();
    private parserLoading: Map<string, Promise<Parser | undefined>> = new Map();
    private treeCache: Map<string, { hash: number; tree: any }> = new Map();
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

    public dispose(): void {
        for (const cached of this.treeCache.values()) {
            cached.tree?.delete?.();
        }
        this.treeCache.clear();
        this.parsers.clear();
        this.languages.clear();
        this.importQueries.clear();
        this.identifierImportQuery.clear();
        this.parserLoading.clear();
        this.initialized = false;
        TreeSitterParser.instance = undefined!;
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

        // Prevent concurrent loads of the same language (race condition → WASM leak)
        if (this.parserLoading.has(langId)) {
            return this.parserLoading.get(langId);
        }

        const loadPromise = this._loadParser(langId);
        this.parserLoading.set(langId, loadPromise);

        try {
            return await loadPromise;
        } finally {
            this.parserLoading.delete(langId);
        }
    }

    private async _loadParser(langId: string): Promise<Parser | undefined> {
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
            const wasmBinary = await fs.promises.readFile(wasmPath);
            const lang = await Parser.Language.load(new Uint8Array(wasmBinary));
            const parser = new Parser();
            parser.setLanguage(lang);

            this.languages.set(langId, lang);
            this.parsers.set(langId, parser);
            log.appendLine(`Language loaded for ${langId}`);

            return parser;
        } catch (e: any) {
            log.appendLine(`Failed to load parser for ${langId}: ${e.message || e}`);
            return undefined;
        }
    }

    public getLanguage(langId: string): Parser.Language | undefined {
        return this.languages.get(langId);
    }

    /**
     * Parse content with a per-language last-tree cache.
     * If the same content (by hash) was parsed before for this language,
     * the cached tree is returned immediately (zero cost).
     * Old trees are automatically deleted when replaced.
     */
    private async parseWithCache(langId: string, content: string): Promise<any | null> {
        const parser = await this.getParser(langId);
        if (!parser) return null;

        const hash = this.hashContent(content);
        const cached = this.treeCache.get(langId);

        if (cached && cached.hash === hash) {
            return cached.tree;
        }

        // Delete old cached tree to free WASM memory
        if (cached) {
            cached.tree.delete();
        }

        const tree = parser.parse(content);
        if (tree) {
            this.treeCache.set(langId, { hash, tree });
        }
        return tree;
    }

    /** djb2 hash — fast O(n) hash for content identity checks */
    private hashContent(content: string): number {
        let hash = 5381;
        for (let i = 0, len = content.length; i < len; i++) {
            hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
        }
        return hash;
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

        const tree = await this.parseWithCache(langId, content);
        if (!tree) return [];

        return this.queryImports(tree, langId);
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

        let matches: any[];
        try {
            matches = query.matches(tree.rootNode);
        } catch {
            // web-tree-sitter marshalNode may crash on certain ASTs with null nodes
            return [];
        }
        const imports: string[] = [];

        for (const match of matches) {
            for (const capture of match.captures) {
                if (capture.name === 'source' && capture.node) {
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

        const tsTree = await this.parseWithCache('typescript', scriptContent);
        if (!tsTree) return null;

        const result = this.findOptionPropertyInTree(tsTree, targetWord);
        if (result) {
            return {
                start: scriptOffset + result.start,
                end: scriptOffset + result.end
            };
        }

        return null;
    }

    /**
     * Collect all Vue Options API property names from a .vue file.
     * Returns an array of { name, source } where source is 'data' | 'methods' | 'computed' | 'props' | 'watch'.
     */
    public async collectVueOptionProperties(
        content: string
    ): Promise<{ name: string; source: 'data' | 'methods' | 'computed' | 'props' | 'watch' }[]> {
        const scriptInfo = this.extractVueScriptInfo(content);
        if (!scriptInfo) return [];

        const { scriptContent } = scriptInfo;

        const tsTree = await this.parseWithCache('typescript', scriptContent);
        if (!tsTree) return [];

        return this.collectOptionPropertiesInTree(tsTree);
    }

    /**
     * Traverse the export default object and collect all property names from
     * data(), methods, computed, and props sections.
     */
    private collectOptionPropertiesInTree(
        tree: any
    ): { name: string; source: 'data' | 'methods' | 'computed' | 'props' | 'watch' }[] {
        const root = tree.rootNode;
        const results: { name: string; source: 'data' | 'methods' | 'computed' | 'props' | 'watch' }[] = [];

        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return results;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return results;

        for (const child of objectNode.children) {
            if (child.type === 'pair' || child.type === 'method_definition') {
                const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
                if (!keyNode) continue;

                const keyName = keyNode.text;

                // methods / computed / props / watch: collect all keys from the value object
                if (['methods', 'computed', 'props', 'watch'].includes(keyName)) {
                    const source = keyName as 'methods' | 'computed' | 'props' | 'watch';
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
        source: 'data' | 'methods' | 'computed' | 'props' | 'watch',
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

    /**
     * Given a property chain like ['obj', 'inner'], resolve the nested object
     * in data/computed/props and return its property names.
     */
    public async collectNestedProperties(
        content: string,
        chain: string[]
    ): Promise<string[]> {
        if (chain.length === 0) return [];

        const scriptInfo = this.extractVueScriptInfo(content);
        if (!scriptInfo) return [];

        const tsTree = await this.parseWithCache('typescript', scriptInfo.scriptContent);
        if (!tsTree) return [];

        const root = tsTree.rootNode;
        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return [];

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return [];

        // Search through data, computed, props, methods for the first property in chain
        let targetNode: any = null;

        for (const child of objectNode.children) {
            if (child.type !== 'pair' && child.type !== 'method_definition') continue;
            const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
            if (!keyNode) continue;
            const keyName = keyNode.text;

            if (keyName === 'data') {
                const bodyNode = child.childForFieldName('body') ||
                    child.childForFieldName('value')?.childForFieldName('body');
                if (bodyNode) {
                    const returnStmt = this.findNodeByType(bodyNode, 'return_statement');
                    if (returnStmt) {
                        const returnObj = this.findNodeByType(returnStmt, 'object');
                        if (returnObj) {
                            targetNode = this.findNestedObject(returnObj, chain);
                            if (targetNode) break;
                        }
                    }
                }
            } else if (['computed', 'props', 'methods'].includes(keyName)) {
                const valueNode = child.childForFieldName('value');
                if (valueNode && valueNode.type === 'object') {
                    targetNode = this.findNestedObject(valueNode, chain);
                    if (targetNode) break;
                }
            }
        }

        if (!targetNode || targetNode.type !== 'object') return [];

        const names: string[] = [];
        for (const c of targetNode.children) {
            if (c.type === 'pair' || c.type === 'method_definition') {
                const k = c.childForFieldName('key') || c.childForFieldName('name');
                if (k) names.push(k.text);
            } else if (c.type === 'shorthand_property_identifier') {
                names.push(c.text);
            }
        }
        return names;
    }

    /**
     * Walk a chain of property names through nested object literals.
     * Returns the value node of the last property in the chain.
     */
    private findNestedObject(objectNode: any, chain: string[]): any {
        let current = objectNode;
        for (const propName of chain) {
            if (!current || current.type !== 'object') return null;
            let found = false;
            for (const child of current.children) {
                if (child.type === 'pair') {
                    const keyNode = child.childForFieldName('key');
                    if (keyNode && keyNode.text === propName) {
                        current = child.childForFieldName('value');
                        found = true;
                        break;
                    }
                }
            }
            if (!found) return null;
        }
        return current;
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

        const tree = await this.parseWithCache(langId, content);
        if (!tree) return null;

        const node = tree.rootNode.descendantForIndex(offset);
        if (!node) return null;

        if (node.type === 'string_fragment' || node.type === 'string') {
            let current: any = node;
            while (current) {
                if (current.type === 'import_statement' ||
                    current.type === 'export_statement' ||
                    (current.type === 'call_expression' &&
                     current.childForFieldName('function')?.text === 'require')) {
                    const text = node.type === 'string_fragment' ? node.text :
                                 node.text.substring(1, node.text.length - 1);
                    return text;
                }
                current = current.parent;
            }
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

        const tree = await this.parseWithCache(langId, content);
        if (!tree) return null;

        const query = this.getIdentifierImportQuery(langId);
        if (!query) return null;

        let matches: any[];
        try {
            matches = query.matches(tree.rootNode);
        } catch {
            return null;
        }

        for (const match of matches) {
            let foundIdentifier = false;
            let sourcePath: string | null = null;

            for (const capture of match.captures) {
                if (!capture.node) continue;
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
                return sourcePath;
            }
        }

        return null;
    }

    private getIdentifierImportQuery(langId: string): Parser.Query | null {
        const cached = this.identifierImportQuery.get(langId);
        if (cached) return cached;

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

        try {
            const query = language.query(queryString);
            this.identifierImportQuery.set(langId, query);
            return query;
        } catch (e) {
            log.appendLine(`Failed to create identifier import query: ${e}`);
            return null;
        }
    }

    /**
     * Extracts timeline events from a parsed AST tree for the Vue Timeline Outline feature.
     * This looks for lifecycle methods and watch definitions in the `export default` object.
     */
    public async getVueTimelineEvents(content: string): Promise<any[]> {
        const langId = 'typescript';
        const tree = await this.parseWithCache(langId, content);
        if (!tree) return [];

        const root = tree.rootNode;
        const events: any[] = [];

        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return events;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return events;

        const LIFECYCLES = new Set([
            'beforeCreate', 'created', 'beforeMount', 'mounted', 
            'beforeUpdate', 'updated', 'activated', 'deactivated', 
            'beforeDestroy', 'destroyed', 'errorCaptured',
            'serverPrefetch', 'renderTracked', 'renderTriggered'
        ]);

        for (const child of objectNode.children) {
             const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
             if (!keyNode) continue;
             const keyName = keyNode.text;

             // Extract lifecycle hooks
             if (child.type === 'method_definition' && LIFECYCLES.has(keyName)) {
                 const actions = this.extractActionsFromStatements(child.childForFieldName('body'));
                 events.push({
                     type: 'lifecycle',
                     name: keyName,
                     start: child.startIndex,
                     end: child.endIndex,
                     actions
                 });
             }

             // Extract properties that are lifecycle hooks (e.g., created: function() { ... } or created: () => { ... })
             if (child.type === 'pair' && LIFECYCLES.has(keyName)) {
                 const valueNode = child.childForFieldName('value');
                 if (valueNode && (valueNode.type === 'function_expression' || valueNode.type === 'arrow_function')) {
                     const bodyNode = valueNode.childForFieldName('body');
                     const actions = this.extractActionsFromStatements(bodyNode);
                     events.push({
                         type: 'lifecycle',
                         name: keyName,
                         start: child.startIndex,
                         end: child.endIndex,
                         actions
                     });
                 }
             }

             // Extract watch
             if (child.type === 'pair' && keyName === 'watch') {
                 const watchObj = child.childForFieldName('value');
                 if (watchObj && watchObj.type === 'object') {
                     for (const watchChild of watchObj.children) {
                         const wKeyNode = watchChild.childForFieldName('key') || watchChild.childForFieldName('name');
                         if (!wKeyNode) continue;
                         const wKeyName = wKeyNode.text.replace(/^['"`]|['"`]$/g, ''); // strip quotes
                         
                         let wBodyNode = null;
                         let isImmediate = false;
                         if (watchChild.type === 'method_definition') {
                             wBodyNode = watchChild.childForFieldName('body');
                         } else if (watchChild.type === 'pair') {
                             const wValueNode = watchChild.childForFieldName('value');
                             if (wValueNode && (wValueNode.type === 'function_expression' || wValueNode.type === 'arrow_function')) {
                                 wBodyNode = wValueNode.childForFieldName('body');
                             } else if (wValueNode && wValueNode.type === 'object') {
                                 // object syntax: watch: { foo: { handler() { ... } } }
                                 let handlerFound = false;
                                 for (const opt of wValueNode.children) {
                                     const optKey = opt.childForFieldName('key') || opt.childForFieldName('name');
                                     if (optKey && optKey.text === 'handler') {
                                         if (opt.type === 'method_definition') {
                                             wBodyNode = opt.childForFieldName('body');
                                         } else if (opt.type === 'pair') {
                                             const handlerVal = opt.childForFieldName('value');
                                             if (handlerVal && (handlerVal.type === 'function_expression' || handlerVal.type === 'arrow_function')) {
                                                 wBodyNode = handlerVal.childForFieldName('body');
                                             }
                                         }
                                         handlerFound = true;
                                     } else if (optKey && optKey.text === 'immediate') {
                                         if (opt.type === 'pair') {
                                             const immVal = opt.childForFieldName('value');
                                             if (immVal && immVal.text === 'true') {
                                                 isImmediate = true;
                                             }
                                         }
                                     }
                                 }
                             }
                         }

                         if (wBodyNode) {
                             const actions = this.extractActionsFromStatements(wBodyNode);
                             events.push({
                                 type: 'watch',
                                 name: `watch('${wKeyName}')`,
                                 start: watchChild.startIndex,
                                 end: watchChild.endIndex,
                                 actions,
                                 isImmediate
                             });
                         }
                     }
                 }
             }
        }

        return events;
    }

    private extractActionsFromStatements(blockNode: any): any[] {
        if (!blockNode) return [];
        
        const actions: any[] = [];
        const processNode = (node: any) => {
            if (!node) return;

            // Method calls: this.fetchData(...) or this.$store.dispatch(...)
            if (node.type === 'call_expression') {
                const funcNode = node.childForFieldName('function');
                if (funcNode && funcNode.type === 'member_expression') {
                    const objectNode = funcNode.childForFieldName('object');
                    if (objectNode && (objectNode.text === 'this' || (objectNode.type === 'member_expression' && objectNode.text.startsWith('this.')))) {
                        actions.push({
                            type: 'call',
                            label: `${funcNode.text}()`,
                            start: node.startIndex,
                            end: node.endIndex
                        });
                    }
                }
            }
            
            // Assignments: this.someProp = 123 or this.obj.prop = 123
            if (node.type === 'assignment_expression') {
                const leftNode = node.childForFieldName('left');
                const rightNode = node.childForFieldName('right');
                if (leftNode && leftNode.type === 'member_expression') {
                    const objectNode = leftNode.childForFieldName('object');
                    if (objectNode && (objectNode.text === 'this' || (objectNode.type === 'member_expression' && objectNode.text.startsWith('this.')))) {
                        let rightText = rightNode ? rightNode.text.replace(/\s+/g, ' ') : '';
                        if (rightText.length > 30) {
                            rightText = rightText.substring(0, 30) + '...';
                        }
                        actions.push({
                            type: 'assignment',
                            label: `${leftNode.text} = ${rightText}`,
                            start: node.startIndex,
                            end: node.endIndex
                        });
                    }
                }
            }

            // Always recurse defensively
            if (node.children && Array.isArray(node.children)) {
                for (const child of node.children) {
                    processNode(child);
                }
            }
        };

        if (blockNode.children && Array.isArray(blockNode.children)) {
            for (const stmt of blockNode.children) {
                 processNode(stmt);
            }
        }

        // Sort actions chronologically
        actions.sort((a, b) => a.start - b.start);

        // Deduplicate assignments / calls that appear on the same AST level/branch to avoid clutter
        // Specifically, if an action modifies the same property as another action, we keep the first one
        // and optionally change it to show it happens conditionally.
        const filteredActions: any[] = [];
        const seenProperties = new Set<string>();

        for (const action of actions) {
            // For assignments, we can extract the left side before '=' 
            // example: "this.a = 2" -> left side: "this.a"
            const match = action.type === 'assignment' ? action.label.split(' =')[0] : action.label;
            
            if (!seenProperties.has(match)) {
                seenProperties.add(match);
                filteredActions.push(action);
            } else {
                // We've seen this before, let's update the existing one to indicate multiple branches
                const existing = filteredActions.find(a => (a.type === 'assignment' ? a.label.split(' =')[0] : a.label) === match);
                if (existing && !existing.label.includes(' (conditional)')) {
                    if (existing.type === 'assignment') {
                        existing.label = `${match} = ... (conditional)`;
                    } else {
                        existing.label = `${match} (conditional)`;
                    }
                }
            }
        }

        return filteredActions;
    }
}
