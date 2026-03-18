import Parser from 'web-tree-sitter';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../extension';
import { context } from '../share';

let ParserModule: any = require('web-tree-sitter');
if (
    typeof ParserModule?.init !== 'function' &&
    typeof ParserModule?.Parser?.init !== 'function'
) {
    try {
        const parserModulePath = require.resolve('web-tree-sitter');
        delete require.cache[parserModulePath];
        ParserModule = require('web-tree-sitter');
    } catch {
        // Ignore cache reset failures; we'll validate runtime API later.
    }
}

function collectParserCandidates(root: any): any[] {
    const result: any[] = [];
    const queue: any[] = [root];
    const seen = new Set<any>();

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);
        result.push(current);

        if ((typeof current === 'object' || typeof current === 'function')) {
            if (current.default) queue.push(current.default);
            if (current.Parser) queue.push(current.Parser);
        }
    }

    return result;
}

// Resolve init() eagerly — it's available before init is called
const parserCandidates = collectParserCandidates(ParserModule);
const parserInitOwner = parserCandidates.find(
    (candidate) => typeof candidate?.init === 'function'
);
const ParserRuntimeInit: any =
    typeof parserInitOwner?.init === 'function'
        ? parserInitOwner.init.bind(parserInitOwner)
        : undefined;

// web-tree-sitter 0.22.x only populates Language and prototype.setLanguage
// AFTER init() is called, so these must be resolved lazily.
let _cachedCtor: any = null;
let _cachedLanguage: any = null;

function getParserRuntimeCtor(): any {
    if (_cachedCtor) return _cachedCtor;
    const candidates = collectParserCandidates(ParserModule);
    _cachedCtor =
        candidates.find((c) =>
            typeof c === 'function' &&
            typeof c.prototype?.setLanguage === 'function'
        ) ||
        candidates.find((c) => typeof c === 'function');
    return _cachedCtor;
}

function getParserRuntimeLanguage(): any {
    if (_cachedLanguage) return _cachedLanguage;
    const ctor = getParserRuntimeCtor();
    const candidates = collectParserCandidates(ParserModule);
    _cachedLanguage =
        ctor?.Language ||
        candidates
            .map((c) => c?.Language)
            .find((lang) => typeof lang?.load === 'function');
    return _cachedLanguage;
}

// Map of language ID to WASM file name
const LANG_WASM_MAP: Record<string, string> = {
    'javascript': 'tree-sitter-javascript.wasm',
    'typescript': 'tree-sitter-typescript.wasm',
    'typescriptreact': 'tree-sitter-tsx.wasm',
};

// Regex to extract <script> or <script lang="ts"/"tsx"> content from Vue SFC
// Global flag to find ALL script blocks; we then prefer the non-setup one.
const VUE_SCRIPT_RE = /<script(\b[^>]*)?>([^]*?)<\/script>/gi;

export type VueOptionSource = 'data' | 'methods' | 'computed' | 'props' | 'watch';

export interface VueOptionsIndexEntry {
    path: string;
    name: string;
    source: VueOptionSource;
    inferredType?: string;
    start: number;
    end: number;
}

export interface VueOptionsIndex {
    properties: VueOptionsIndexEntry[];
    entriesByPath: Map<string, VueOptionsIndexEntry>;
    childrenByPath: Map<string, VueOptionsIndexEntry[]>;
}

export class TreeSitterParser {
    private static instance: TreeSitterParser;
    private parsers: Map<string, Parser> = new Map();
    private languages: Map<string, Parser.Language> = new Map();
    private importQueries: Map<string, Parser.Query> = new Map();
    private identifierImportQuery: Map<string, Parser.Query> = new Map();
    private parserLoading: Map<string, Promise<Parser | undefined>> = new Map();
    /** LRU tree cache keyed by content hash — avoids thrashing when parsing multiple files */
    private treeCache: Map<number, { langId: string; tree: any }> = new Map();
    private static readonly TREE_CACHE_MAX = 50;
    private vueOptionsIndexCache: Map<number, VueOptionsIndex> = new Map();
    private static readonly VUE_OPTIONS_INDEX_CACHE_MAX = 50;
    private wasmDir: string;
    private initialized = false;
    private initPromise?: Promise<void>;
    private missingLanguageLog = new Set<string>();

    private constructor(wasmDir: string) {
        this.wasmDir = wasmDir;
    }

    private static pushUnique(candidates: string[], candidate?: string): void {
        if (!candidate) return;
        const normalized = path.resolve(candidate);
        if (!candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    }

    private static buildWasmDirCandidates(preferredPath?: string): string[] {
        const candidates: string[] = [];

        TreeSitterParser.pushUnique(candidates, preferredPath);

        if (context?.extensionPath) {
            TreeSitterParser.pushUnique(candidates, path.join(context.extensionPath, 'src', 'grammars'));
            TreeSitterParser.pushUnique(candidates, path.join(context.extensionPath, 'grammars'));
        }

        TreeSitterParser.pushUnique(candidates, path.join(process.cwd(), 'src', 'grammars'));
        TreeSitterParser.pushUnique(candidates, path.join(process.cwd(), 'grammars'));
        TreeSitterParser.pushUnique(candidates, path.resolve(__dirname, '../grammars'));
        TreeSitterParser.pushUnique(candidates, path.resolve(__dirname, '../../src/grammars'));

        return candidates;
    }

    private static isValidWasmDir(dir: string): boolean {
        return fs.existsSync(path.join(dir, 'tree-sitter-javascript.wasm')) &&
               fs.existsSync(path.join(dir, 'tree-sitter-typescript.wasm'));
    }

    private static resolveWasmDir(preferredPath?: string): string | undefined {
        const candidates = TreeSitterParser.buildWasmDirCandidates(preferredPath);
        for (const candidate of candidates) {
            if (TreeSitterParser.isValidWasmDir(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    private refreshWasmDir(preferredPath?: string): void {
        const resolved = TreeSitterParser.resolveWasmDir(preferredPath);
        if (resolved && resolved !== this.wasmDir) {
            this.wasmDir = resolved;
            log.appendLine(`TreeSitter wasmDir switched to: ${this.wasmDir}`);
        }
    }

    private resolveCoreWasmPath(): string | null {
        const candidates: string[] = [];

        TreeSitterParser.pushUnique(
            candidates,
            path.join(this.wasmDir, '..', '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
        );
        TreeSitterParser.pushUnique(
            candidates,
            path.join(this.wasmDir, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
        );
        if (context?.extensionPath) {
            TreeSitterParser.pushUnique(
                candidates,
                path.join(context.extensionPath, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
            );
        }
        TreeSitterParser.pushUnique(
            candidates,
            path.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
        );

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    public static getInstance(contextOrPath?: string): TreeSitterParser {
        const resolvedPath = TreeSitterParser.resolveWasmDir(contextOrPath);

        if (!TreeSitterParser.instance) {
            const fallbackPath =
                resolvedPath ||
                contextOrPath ||
                path.join(process.cwd(), 'src', 'grammars');
            TreeSitterParser.instance = new TreeSitterParser(fallbackPath);
        }

        if (resolvedPath) {
            TreeSitterParser.instance.refreshWasmDir(resolvedPath);
        } else {
            TreeSitterParser.instance.refreshWasmDir();
        }

        return TreeSitterParser.instance;
    }

    public dispose(): void {
        for (const cached of this.treeCache.values()) {
            cached.tree?.delete?.();
        }
        this.treeCache.clear();
        this.vueOptionsIndexCache.clear();
        this.parsers.clear();
        this.languages.clear();
        this.importQueries.clear();
        this.identifierImportQuery.clear();
        this.parserLoading.clear();
        this.initialized = false;
        TreeSitterParser.instance = undefined!;
    }

    /** Evict oldest cache entries when cache exceeds max size */
    private evictTreeCache(): void {
        while (this.treeCache.size > TreeSitterParser.TREE_CACHE_MAX) {
            const oldest = this.treeCache.keys().next().value;
            if (oldest === undefined) break;
            const entry = this.treeCache.get(oldest);
            entry?.tree?.delete?.();
            this.treeCache.delete(oldest);
        }
    }

    private createEmptyVueOptionsIndex(): VueOptionsIndex {
        return {
            properties: [],
            entriesByPath: new Map(),
            childrenByPath: new Map(),
        };
    }

    private evictVueOptionsIndexCache(): void {
        while (this.vueOptionsIndexCache.size > TreeSitterParser.VUE_OPTIONS_INDEX_CACHE_MAX) {
            const oldest = this.vueOptionsIndexCache.keys().next().value;
            if (oldest === undefined) break;
            this.vueOptionsIndexCache.delete(oldest);
        }
    }

    public async init(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                this.refreshWasmDir(this.wasmDir);
                const treeSitterWasmPath = this.resolveCoreWasmPath();
                if (!treeSitterWasmPath) {
                    throw new Error(
                        `Cannot locate web-tree-sitter core wasm. wasmDir=${this.wasmDir}`
                    );
                }
                log.appendLine(`TreeSitter wasmDir: ${this.wasmDir}`);
                log.appendLine(`TreeSitter wasm path: ${treeSitterWasmPath}`);

                log.appendLine('Step 1: About to call Parser.init()');
                try {
                    if (typeof ParserRuntimeInit !== 'function') {
                        throw new Error('web-tree-sitter init API not found');
                    }
                    await ParserRuntimeInit({
                        locateFile(scriptName: string) {
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
            } finally {
                this.initPromise = undefined;
            }
        })();

        return this.initPromise;
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

        this.refreshWasmDir(this.wasmDir);
        const tried: string[] = [];

        for (const candidateDir of TreeSitterParser.buildWasmDirCandidates(this.wasmDir)) {
            const wasmPath = path.join(candidateDir, wasmFile);
            tried.push(wasmPath);
            if (!fs.existsSync(wasmPath)) {
                continue;
            }

            try {
                const Ctor = getParserRuntimeCtor();
                const Lang = getParserRuntimeLanguage();
                if (typeof Ctor !== 'function' || !Lang?.load) {
                    throw new Error('web-tree-sitter parser ctor or language API not found');
                }
                log.appendLine(`Loading language WASM: ${wasmPath}`);
                const wasmBinary = await fs.promises.readFile(wasmPath);
                const lang = await Lang.load(new Uint8Array(wasmBinary));
                const parser = new Ctor();
                parser.setLanguage(lang);

                this.languages.set(langId, lang);
                this.parsers.set(langId, parser);
                this.wasmDir = candidateDir;
                this.missingLanguageLog.delete(langId);
                log.appendLine(`Language loaded for ${langId}`);

                return parser;
            } catch (e: any) {
                log.appendLine(`Failed to load parser for ${langId} from ${wasmPath}: ${e.message || e}`);
            }
        }

        if (!this.missingLanguageLog.has(langId)) {
            this.missingLanguageLog.add(langId);
            log.appendLine(
                `Failed to locate/load language wasm for ${langId}. Tried: ${tried.join(' | ')}`
            );
        }

        return undefined;
    }

    public getLanguage(langId: string): Parser.Language | undefined {
        return this.languages.get(langId);
    }

    /**
     * Parse content with a content-hash-keyed LRU cache.
     * If the same content was parsed before, the cached tree is returned
     * immediately (zero cost). Old entries are evicted when cache is full.
     */
    public async parseWithCache(langId: string, content: string): Promise<any | null> {
        const parser = await this.getParser(langId);
        if (!parser) return null;

        const hash = this.hashContent(content);
        const cached = this.treeCache.get(hash);

        if (cached && cached.langId === langId) {
            // Move to end (most recently used) by re-inserting
            this.treeCache.delete(hash);
            this.treeCache.set(hash, cached);
            return cached.tree;
        }

        const tree = parser.parse(content);
        if (tree) {
            this.treeCache.set(hash, { langId, tree });
            this.evictTreeCache();
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

    /**
     * Find the best <script> block from a Vue SFC.
     * Prefers the non-setup script block (Options API) over <script setup>.
     */
    private findBestScriptMatch(content: string): { attrs: string; body: string; index: number; fullMatch: string } | null {
        VUE_SCRIPT_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        let bestMatch: { attrs: string; body: string; index: number; fullMatch: string } | null = null;

        while ((match = VUE_SCRIPT_RE.exec(content)) !== null) {
            const attrs = match[1] || '';
            const body = match[2];
            const isSetup = /\bsetup\b/.test(attrs);
            if (!bestMatch || !isSetup) {
                bestMatch = { attrs, body, index: match.index, fullMatch: match[0] };
                if (!isSetup) break; // Prefer non-setup, stop searching
            }
        }
        return bestMatch;
    }

    private extractVueScript(content: string): string | null {
        const match = this.findBestScriptMatch(content);
        return match ? match.body : null;
    }

    public extractVueScriptInfo(content: string): { scriptContent: string; scriptOffset: number } | null {
        const match = this.findBestScriptMatch(content);
        if (!match) return null;
        return {
            scriptContent: match.body,
            scriptOffset: match.index + match.fullMatch.indexOf(match.body),
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
     * Build a shared Vue Options index for completions and definitions.
     */
    public async getVueOptionsIndex(content: string): Promise<VueOptionsIndex> {
        const hash = this.hashContent(content);
        const cached = this.vueOptionsIndexCache.get(hash);
        if (cached) {
            this.vueOptionsIndexCache.delete(hash);
            this.vueOptionsIndexCache.set(hash, cached);
            return cached;
        }

        let index = this.createEmptyVueOptionsIndex();
        const scriptInfo = this.extractVueScriptInfo(content);
        if (scriptInfo) {
            const { scriptContent, scriptOffset } = scriptInfo;
            const tsTree = await this.parseWithCache('typescript', scriptContent);
            if (tsTree) {
                index = this.buildVueOptionsIndex(tsTree, scriptOffset);
            }
        }

        this.vueOptionsIndexCache.set(hash, index);
        this.evictVueOptionsIndexCache();
        return index;
    }

    /**
     * Find Vue Options definition (data/methods/computed/props/watch) in a .vue file.
     * Returns the absolute offset range in the original Vue file.
     */
    public async findVueOptionDefinition(
        content: string,
        targetWord: string,
        chain: string[] = []
    ): Promise<{ start: number; end: number } | null> {
        const index = await this.getVueOptionsIndex(content);
        const pathKey = chain.length > 0 ? chain.join('.') : targetWord;
        const entry = index.entriesByPath.get(pathKey) || index.entriesByPath.get(targetWord);

        if (!entry) return null;
        return {
            start: entry.start,
            end: entry.end
        };
    }

    /**
     * Collect all Vue Options API property names from a .vue file.
     * Returns an array of { name, source } where source is 'data' | 'methods' | 'computed' | 'props' | 'watch'.
     */
    public async collectVueOptionProperties(
        content: string
    ): Promise<{ name: string; source: VueOptionSource; inferredType?: string }[]> {
        const index = await this.getVueOptionsIndex(content);
        return index.properties.map(({ name, source, inferredType }) => ({
            name,
            source,
            inferredType
        }));
    }

    private buildVueOptionsIndex(tree: any, scriptOffset: number): VueOptionsIndex {
        const root = tree.rootNode;
        const index = this.createEmptyVueOptionsIndex();

        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return index;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return index;

        for (const child of objectNode.children) {
            if (child.type !== 'pair' && child.type !== 'method_definition') {
                continue;
            }

            const keyName = this.getObjectPropertyName(child);
            if (!keyName) continue;

            if (keyName === 'data') {
                const returnObject = this.findDataReturnObject(child);
                if (returnObject) {
                    this.indexTopLevelSectionProperties(index, returnObject, 'data', scriptOffset);
                }
                continue;
            }

            if (!['methods', 'computed', 'props', 'watch'].includes(keyName)) {
                continue;
            }

            const source = keyName as VueOptionSource;
            const valueNode = child.childForFieldName('value');

            if (valueNode && valueNode.type === 'object') {
                this.indexTopLevelSectionProperties(index, valueNode, source, scriptOffset);
            }

            if (source === 'props' && valueNode && valueNode.type === 'array') {
                this.indexPropsArrayProperties(index, valueNode, scriptOffset);
            }
        }

        return index;
    }

    private indexTopLevelSectionProperties(
        index: VueOptionsIndex,
        objectNode: any,
        source: VueOptionSource,
        scriptOffset: number
    ): void {
        for (const child of objectNode.children) {
            if (!this.isIndexableObjectProperty(child)) {
                continue;
            }

            const name = this.getObjectPropertyName(child);
            const range = this.getObjectPropertyRange(child);
            if (!name || !range) continue;

            const entry: VueOptionsIndexEntry = {
                path: name,
                name,
                source,
                inferredType: this.getTopLevelEntryType(child, source),
                start: scriptOffset + range.start,
                end: scriptOffset + range.end,
            };

            const isPrimaryPath = this.addVueOptionsIndexEntry(index, entry);
            if (!isPrimaryPath) continue;

            const nestedObject = this.getTopLevelNestedObjectNode(child, source);
            if (nestedObject) {
                this.indexNestedObjectLiteral(index, nestedObject, source, entry.path, scriptOffset);
            }
        }
    }

    private indexPropsArrayProperties(
        index: VueOptionsIndex,
        arrayNode: any,
        scriptOffset: number
    ): void {
        for (const elem of arrayNode.children) {
            if (elem.type !== 'string' && elem.type !== 'string_fragment') {
                continue;
            }

            const name = elem.text.replace(/^['"`]|['"`]$/g, '');
            if (!name) continue;

            this.addVueOptionsIndexEntry(index, {
                path: name,
                name,
                source: 'props',
                start: scriptOffset + elem.startIndex,
                end: scriptOffset + elem.endIndex,
            });
        }
    }

    private indexNestedObjectLiteral(
        index: VueOptionsIndex,
        objectNode: any,
        source: VueOptionSource,
        parentPath: string,
        scriptOffset: number
    ): void {
        for (const child of objectNode.children) {
            if (!this.isIndexableObjectProperty(child)) {
                continue;
            }

            const name = this.getObjectPropertyName(child);
            const range = this.getObjectPropertyRange(child);
            if (!name || !range) continue;

            const path = `${parentPath}.${name}`;
            const entry: VueOptionsIndexEntry = {
                path,
                name,
                source,
                inferredType: this.getNestedLiteralEntryType(child),
                start: scriptOffset + range.start,
                end: scriptOffset + range.end,
            };

            const isPrimaryPath = this.addVueOptionsIndexEntry(index, entry, parentPath);
            if (!isPrimaryPath) continue;

            const nestedObject = this.getNestedLiteralObjectNode(child);
            if (nestedObject) {
                this.indexNestedObjectLiteral(index, nestedObject, source, path, scriptOffset);
            }
        }
    }

    private addVueOptionsIndexEntry(
        index: VueOptionsIndex,
        entry: VueOptionsIndexEntry,
        parentPath?: string
    ): boolean {
        if (parentPath) {
            const siblings = index.childrenByPath.get(parentPath) || [];
            siblings.push(entry);
            index.childrenByPath.set(parentPath, siblings);
        } else {
            index.properties.push(entry);
        }

        if (index.entriesByPath.has(entry.path)) {
            return false;
        }

        index.entriesByPath.set(entry.path, entry);
        return true;
    }

    /**
     * Infer a type string from a tree-sitter AST value node.
     */
    private inferTypeFromNode(node: any, depth: number = 0): string {
        if (!node) return 'any';
        const type = node.type;

        if (type === 'number') return 'number';
        if (type === 'string' || type === 'template_string') return 'string';
        if (type === 'true' || type === 'false') return 'boolean';
        if (type === 'null') return 'null';
        if (type === 'undefined') return 'undefined';
        if (type === 'arrow_function' || type === 'function' || type === 'function_expression') return 'Function';

        if (type === 'new_expression') {
            const ctorNode = node.childForFieldName('constructor');
            if (ctorNode) return ctorNode.text;
            return 'object';
        }

        if (type === 'array') {
            const elements = node.children.filter(
                (c: any) => c.type !== ',' && c.type !== '[' && c.type !== ']'
            );
            if (elements.length === 0) return 'any[]';
            if (depth >= 3) return 'any[]';
            const elementTypes = new Set(
                elements.map((e: any) => this.inferTypeFromNode(e, depth + 1))
            );
            if (elementTypes.size === 1) return `${[...elementTypes][0]}[]`;
            return 'any[]';
        }

        if (type === 'object') {
            if (depth >= 3) return 'object';
            const pairs: string[] = [];
            for (const child of node.children) {
                if (child.type === 'pair') {
                    const keyNode = child.childForFieldName('key');
                    const valueNode = child.childForFieldName('value');
                    if (keyNode) {
                        const valType = this.inferTypeFromNode(valueNode, depth + 1);
                        pairs.push(`${keyNode.text}: ${valType}`);
                    }
                } else if (child.type === 'shorthand_property_identifier') {
                    pairs.push(`${child.text}: any`);
                }
            }
            if (pairs.length === 0) return 'object';
            return `{ ${pairs.join(', ')} }`;
        }

        // Parenthesized expression: unwrap
        if (type === 'parenthesized_expression') {
            const inner = node.children.find(
                (c: any) => c.type !== '(' && c.type !== ')'
            );
            if (inner) return this.inferTypeFromNode(inner, depth);
        }

        return 'any';
    }

    /**
     * Infer the return type from a computed property function body.
     */
    private inferComputedReturnType(node: any): string {
        const returnValue = this.findReturnValueNode(node);
        if (!returnValue) return 'any';
        return this.inferTypeFromNode(returnValue);
    }

    /**
     * Infer type from a props definition with object syntax.
     * e.g. { type: String } → 'string', { type: [String, Number] } → 'string | number'
     */
    private inferPropType(node: any): string {
        // node is the value of a pair in props object
        if (!node) return 'any';

        // Direct constructor: props: { foo: String }
        if (node.type === 'identifier') {
            return this.constructorToType(node.text);
        }

        // Array shorthand: props: { foo: [String, Number] }
        if (node.type === 'array') {
            const types = node.children
                .filter((c: any) => c.type === 'identifier')
                .map((c: any) => this.constructorToType(c.text));
            return types.length > 0 ? types.join(' | ') : 'any';
        }

        // Object syntax: props: { foo: { type: String, default: ... } }
        if (node.type === 'object') {
            for (const child of node.children) {
                if (child.type === 'pair') {
                    const keyNode = child.childForFieldName('key');
                    if (keyNode && keyNode.text === 'type') {
                        const valueNode = child.childForFieldName('value');
                        if (valueNode) return this.inferPropType(valueNode);
                    }
                }
            }
        }

        return 'any';
    }

    private constructorToType(name: string): string {
        switch (name) {
            case 'String': return 'string';
            case 'Number': return 'number';
            case 'Boolean': return 'boolean';
            case 'Array': return 'any[]';
            case 'Object': return 'object';
            case 'Function': return 'Function';
            case 'Date': return 'Date';
            case 'Symbol': return 'symbol';
            default: return name;
        }
    }

    /**
     * Given a property chain like ['obj', 'inner'], return the indexed children.
     */
    public async collectNestedProperties(
        content: string,
        chain: string[]
    ): Promise<{ name: string; inferredType?: string }[]> {
        if (chain.length === 0) return [];
        const index = await this.getVueOptionsIndex(content);
        const entries = index.childrenByPath.get(chain.join('.')) || [];
        return entries.map(({ name, inferredType }) => ({ name, inferredType }));
    }

    private getTopLevelEntryType(node: any, source: VueOptionSource): string | undefined {
        if (source === 'methods') {
            return 'Function';
        }

        if (source === 'computed') {
            return this.normalizeInferredType(this.inferComputedReturnType(node));
        }

        const valueNode = node.childForFieldName('value');
        if (!valueNode) {
            return node.type === 'method_definition' ? 'Function' : undefined;
        }

        if (source === 'props') {
            return this.normalizeInferredType(this.inferPropType(valueNode));
        }

        if (source === 'data') {
            return this.normalizeInferredType(this.inferTypeFromNode(valueNode));
        }

        return undefined;
    }

    private getNestedLiteralEntryType(node: any): string | undefined {
        if (node.type === 'method_definition') {
            return 'Function';
        }

        const valueNode = node.childForFieldName('value');
        if (!valueNode) return undefined;
        return this.normalizeInferredType(this.inferTypeFromNode(valueNode));
    }

    private getTopLevelNestedObjectNode(node: any, source: VueOptionSource): any | null {
        if (source === 'data') {
            const valueNode = node.childForFieldName('value');
            return valueNode?.type === 'object' ? valueNode : null;
        }

        if (source === 'computed') {
            const returnValue = this.findReturnValueNode(node);
            return returnValue?.type === 'object' ? returnValue : null;
        }

        return null;
    }

    private getNestedLiteralObjectNode(node: any): any | null {
        const valueNode = node.childForFieldName('value');
        return valueNode?.type === 'object' ? valueNode : null;
    }

    private normalizeInferredType(type?: string): string | undefined {
        if (!type || type === 'any') return undefined;
        return type;
    }

    private isIndexableObjectProperty(node: any): boolean {
        return node.type === 'pair' ||
            node.type === 'method_definition' ||
            node.type === 'shorthand_property_identifier';
    }

    private getObjectPropertyName(node: any): string | null {
        if (node.type === 'shorthand_property_identifier') {
            return node.text;
        }

        const keyNode = node.childForFieldName('key') || node.childForFieldName('name');
        return keyNode?.text || null;
    }

    private getObjectPropertyRange(node: any): { start: number; end: number } | null {
        if (!this.isIndexableObjectProperty(node)) {
            return null;
        }

        return {
            start: node.startIndex,
            end: node.endIndex,
        };
    }

    private findDataReturnObject(node: any): any | null {
        const bodyNode = node.childForFieldName('body') ||
            node.childForFieldName('value')?.childForFieldName('body');
        if (!bodyNode) return null;

        const returnValue = this.findReturnValueNodeInBody(bodyNode);
        return returnValue?.type === 'object' ? returnValue : null;
    }

    private findReturnValueNode(node: any): any | null {
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
            const returnValue = this.findReturnValueNodeInBody(bodyNode);
            if (returnValue) return returnValue;
        }

        const valueNode = node.childForFieldName('value');
        if (!valueNode) return null;

        const valueBodyNode = valueNode.childForFieldName('body');
        if (valueBodyNode) {
            const returnValue = this.findReturnValueNodeInBody(valueBodyNode);
            if (returnValue) return returnValue;
        }

        if (valueNode.type === 'object') {
            for (const child of valueNode.children) {
                if (child.type !== 'method_definition' && child.type !== 'pair') {
                    continue;
                }

                const keyName = this.getObjectPropertyName(child);
                if (keyName === 'get') {
                    return this.findReturnValueNode(child);
                }
            }
        }

        return null;
    }

    private findReturnValueNodeInBody(bodyNode: any): any | null {
        const returnStmt = this.findNodeByType(bodyNode, 'return_statement');
        if (!returnStmt) return null;

        return returnStmt.children.find(
            (child: any) => child.type !== 'return' && child.type !== ';'
        ) || null;
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

    /**
     * 在光标所在位置解析 import 语句，返回该 import 的本地绑定名列表。
     * - 如果光标正好落在某个导入标识符上，preferredLocalName 会尽量指向“本地可用名称”（考虑 as 别名）。
     * - 如果光标不在具体标识符上，则会按优先级选择默认导入 > namespace 导入 > 单个 named 导入。
     */
    public async getImportLocalNamesAtPosition(
        content: string,
        filePath: string,
        offset: number
    ): Promise<{ preferredLocalName: string | null; localNames: string[] } | null> {
        const langId = this.getLangId(filePath);
        if (!langId) return null;

        if (langId === 'vue') {
            const scriptInfo = this.extractVueScriptInfo(content);
            if (!scriptInfo) return null;

            const { scriptContent, scriptOffset } = scriptInfo;
            if (offset < scriptOffset || offset >= scriptOffset + scriptContent.length) {
                return null;
            }

            const relativeOffset = offset - scriptOffset;
            return this.getImportLocalNamesAtPosition(scriptContent, 'temp.ts', relativeOffset);
        }

        if (content.length === 0) return null;
        const safeOffset = Math.min(Math.max(0, offset), content.length - 1);

        const tree = await this.parseWithCache(langId, content);
        if (!tree) return null;

        const cursorNode = tree.rootNode.descendantForIndex(safeOffset);
        if (!cursorNode) return null;

        let importStmt: any = cursorNode;
        while (importStmt && importStmt.type !== 'import_statement') {
            importStmt = importStmt.parent;
        }
        if (!importStmt) return null;

        const importClause =
            importStmt.children?.find((c: any) => c?.type === 'import_clause') ||
            importStmt.namedChildren?.find((c: any) => c?.type === 'import_clause');
        if (!importClause) return null;

        let defaultLocal: string | null = null;
        let namespaceLocal: string | null = null;
        const namedLocals: string[] = [];

        for (const child of importClause.children || []) {
            if (!child) continue;

            if (child.type === 'identifier') {
                defaultLocal = child.text;
                continue;
            }

            if (child.type === 'namespace_import') {
                const id = (child.children || []).find((c: any) => c?.type === 'identifier');
                if (id?.text) {
                    namespaceLocal = id.text;
                }
                continue;
            }

            if (child.type === 'named_imports') {
                for (const spec of child.children || []) {
                    if (!spec || spec.type !== 'import_specifier') continue;
                    const aliasNode = spec.childForFieldName('alias');
                    const nameNode = spec.childForFieldName('name');
                    const local = aliasNode?.text || nameNode?.text;
                    if (local) {
                        namedLocals.push(local);
                    }
                }
            }
        }

        const localNames = [defaultLocal, namespaceLocal, ...namedLocals].filter(
            (x): x is string => Boolean(x)
        );
        if (localNames.length === 0) return null;

        // 去重（保持顺序）
        const uniqueLocalNames: string[] = [];
        const seen = new Set<string>();
        for (const n of localNames) {
            if (seen.has(n)) continue;
            seen.add(n);
            uniqueLocalNames.push(n);
        }

        // preferred：如果光标落在 import 的 identifier 上，优先选择其“本地可用名”
        let preferredLocalName: string | null = null;
        let idNode: any = cursorNode;
        while (idNode && idNode !== importStmt) {
            if (idNode.type === 'identifier') break;
            idNode = idNode.parent;
        }

        if (idNode?.type === 'identifier') {
            const parent = idNode.parent;
            if (parent?.type === 'import_specifier') {
                const aliasNode = parent.childForFieldName('alias');
                const nameNode = parent.childForFieldName('name');
                preferredLocalName = aliasNode?.text || nameNode?.text || idNode.text;
            } else {
                preferredLocalName = idNode.text;
            }
        } else {
            // 光标不在具体标识符上：按“更像组件导入”的优先级挑一个
            preferredLocalName =
                defaultLocal ||
                namespaceLocal ||
                (namedLocals.length === 1 ? namedLocals[0] : null);
        }

        return { preferredLocalName, localNames: uniqueLocalNames };
    }

    /**
     * 归一化组件名：用于把模板标签名与导入标识符做“弱匹配”。
     * - 去掉 `-` / `_` 分隔符
     * - 转小写
     */
    private normalizeComponentName(name: string): string {
        return name.replace(/[-_]/g, '').toLowerCase();
    }

    /**
     * 把标签名转成 PascalCase（kebab/snake/camel/Pascal 都可）。
     * 仅用于优先级匹配（不作为最终唯一依据）。
     */
    private toPascalCaseFromTagName(name: string): string {
        return name
            .split(/[-_]+/g)
            .filter(Boolean)
            .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
            .join('');
    }

    /**
     * 根据 Vue 模板中的组件标签名（如 `my-com` / `my_com` / `mycom` / `MyCom`），
     * 在当前文件的 import 列表中找到对应的 source 路径。
     *
     * 规则：
     * 1) 先尝试精确匹配（tagName 原样、以及 tagName 转 PascalCase）
     * 2) 再做归一化弱匹配：去掉 `-/_` 并忽略大小写
     *
     * 说明：Vue 2 模板里 `MyCom` 与 `my-com` 语义等价，但用户可能写出更多变体；
     * 这里用归一化匹配尽量覆盖各种写法。
     */
    public async findImportPathForComponentTag(
        content: string,
        filePath: string,
        tagName: string
    ): Promise<string | null> {
        if (!tagName) return null;

        const langId = this.getLangId(filePath);
        if (!langId) return null;

        if (langId === 'vue') {
            const scriptInfo = this.extractVueScriptInfo(content);
            if (!scriptInfo) return null;
            return this.findImportPathForComponentTag(
                scriptInfo.scriptContent,
                'temp.ts',
                tagName
            );
        }

        const tree = await this.parseWithCache(langId, content);
        if (!tree) return null;

        const query = this.getIdentifierImportQuery(langId);
        if (!query) return null;

        let matches: any[];
        try {
            matches = query.matches(tree.rootNode);
        } catch {
            // web-tree-sitter marshalNode 可能在某些 AST 上抛错，这里做降级处理
            return null;
        }

        const tagPascal = this.toPascalCaseFromTagName(tagName);
        const tagNormalized = this.normalizeComponentName(tagName);

        let fallback: string | null = null;

        for (const match of matches) {
            let sourcePath: string | null = null;

            for (const capture of match.captures) {
                if (capture.name === 'source' && capture.node) {
                    const text = capture.node.text;
                    if (text.length >= 2) {
                        sourcePath = text.substring(1, text.length - 1);
                    }
                }
            }

            if (!sourcePath) continue;

            for (const capture of match.captures) {
                if (!capture.node) continue;
                if (capture.name !== 'default_import' && capture.name !== 'named_import') {
                    continue;
                }

                let localName = capture.node.text;

                // 处理 import { Foo as Bar } from '...'
                // query 捕获的是 name(Foo)，但本地可用标识符是 alias(Bar)。
                if (capture.name === 'named_import') {
                    const specifierNode = capture.node.parent;
                    const aliasNode = specifierNode?.childForFieldName('alias');
                    if (aliasNode?.text) {
                        localName = aliasNode.text;
                    }
                }

                // ✅ 优先精确匹配（原样 / PascalCase）
                if (localName === tagName || localName === tagPascal) {
                    return sourcePath;
                }

                // ✅ 弱匹配（去分隔符 + 忽略大小写）
                if (this.normalizeComponentName(localName) === tagNormalized) {
                    fallback = fallback ?? sourcePath;
                }
            }
        }

        return fallback;
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
        const seenProperties = new Map<string, any>(); // key → action (for O(1) lookup)

        for (const action of actions) {
            // For assignments, we can extract the left side before '=' 
            // example: "this.a = 2" -> left side: "this.a"
            const match = action.type === 'assignment' ? action.label.split(' =')[0] : action.label;
            
            if (!seenProperties.has(match)) {
                seenProperties.set(match, action);
                filteredActions.push(action);
            } else {
                // We've seen this before, let's update the existing one to indicate multiple branches
                const existing = seenProperties.get(match);
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

    /**
     * Build a call graph for a Vue component's script content.
     * Returns all methods (lifecycle, watcher, and regular) with their call sites,
     * assignment sites, and data initial values.
     */
    public async buildComponentCallGraph(scriptContent: string): Promise<{
        methods: Map<string, {
            name: string;
            calls: { methodName: string; start: number; end: number }[];
            assignments: { variableName: string; fullExpression: string; start: number; end: number }[];
            start: number;
            end: number;
            isLifecycle?: boolean;
            isWatcher?: boolean;
            watchTarget?: string;
        }>;
        dataInitialValues: Map<string, { variableName: string; valueText: string; start: number; end: number }>;
    }> {
        const methods = new Map<string, {
            name: string;
            calls: { methodName: string; start: number; end: number }[];
            assignments: { variableName: string; fullExpression: string; start: number; end: number }[];
            start: number;
            end: number;
            isLifecycle?: boolean;
            isWatcher?: boolean;
            watchTarget?: string;
        }>();
        const dataInitialValues = new Map<string, { variableName: string; valueText: string; start: number; end: number }>();

        const tree = await this.parseWithCache('typescript', scriptContent);
        if (!tree) return { methods, dataInitialValues };

        const root = tree.rootNode;
        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return { methods, dataInitialValues };

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return { methods, dataInitialValues };

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

            // --- data(): extract initial values ---
            if (keyName === 'data') {
                const bodyNode = child.childForFieldName('body') ||
                    child.childForFieldName('value')?.childForFieldName('body');
                if (bodyNode) {
                    const returnStmt = this.findNodeByType(bodyNode, 'return_statement');
                    if (returnStmt) {
                        const returnObj = this.findNodeByType(returnStmt, 'object');
                        if (returnObj) {
                            for (const prop of returnObj.children) {
                                if (prop.type === 'pair') {
                                    const pKey = prop.childForFieldName('key');
                                    const pVal = prop.childForFieldName('value');
                                    if (pKey && pVal) {
                                        dataInitialValues.set(pKey.text, {
                                            variableName: pKey.text,
                                            valueText: pVal.text,
                                            start: prop.startIndex,
                                            end: prop.endIndex,
                                        });
                                    }
                                } else if (prop.type === 'shorthand_property_identifier') {
                                    dataInitialValues.set(prop.text, {
                                        variableName: prop.text,
                                        valueText: prop.text,
                                        start: prop.startIndex,
                                        end: prop.endIndex,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // --- methods: extract method definitions ---
            if (keyName === 'methods') {
                const valueNode = child.childForFieldName('value');
                if (valueNode && valueNode.type === 'object') {
                    for (const methodChild of valueNode.children) {
                        const mKeyNode = methodChild.childForFieldName('key') || methodChild.childForFieldName('name');
                        if (!mKeyNode) continue;
                        const mBodyNode = methodChild.childForFieldName('body') ||
                            methodChild.childForFieldName('value')?.childForFieldName('body');
                        if (mBodyNode) {
                            const { calls, assigns } = this.extractCallsAndAssignments(mBodyNode);
                            methods.set(mKeyNode.text, {
                                name: mKeyNode.text,
                                calls,
                                assignments: assigns,
                                start: methodChild.startIndex,
                                end: methodChild.endIndex,
                            });
                        }
                    }
                }
            }

            // --- lifecycle hooks ---
            if (LIFECYCLES.has(keyName)) {
                let bodyNode: any = null;
                if (child.type === 'method_definition') {
                    bodyNode = child.childForFieldName('body');
                } else if (child.type === 'pair') {
                    const valueNode = child.childForFieldName('value');
                    if (valueNode && (valueNode.type === 'function_expression' || valueNode.type === 'arrow_function')) {
                        bodyNode = valueNode.childForFieldName('body');
                    }
                }
                if (bodyNode) {
                    const { calls, assigns } = this.extractCallsAndAssignments(bodyNode);
                    methods.set(keyName, {
                        name: keyName,
                        calls,
                        assignments: assigns,
                        start: child.startIndex,
                        end: child.endIndex,
                        isLifecycle: true,
                    });
                }
            }

            // --- watch ---
            if (keyName === 'watch' && child.type === 'pair') {
                const watchObj = child.childForFieldName('value');
                if (watchObj && watchObj.type === 'object') {
                    for (const watchChild of watchObj.children) {
                        const wKeyNode = watchChild.childForFieldName('key') || watchChild.childForFieldName('name');
                        if (!wKeyNode) continue;
                        const wKeyName = wKeyNode.text.replace(/^['"`]|['"`]$/g, '');

                        let wBodyNode: any = null;
                        if (watchChild.type === 'method_definition') {
                            wBodyNode = watchChild.childForFieldName('body');
                        } else if (watchChild.type === 'pair') {
                            const wValueNode = watchChild.childForFieldName('value');
                            if (wValueNode && (wValueNode.type === 'function_expression' || wValueNode.type === 'arrow_function')) {
                                wBodyNode = wValueNode.childForFieldName('body');
                            } else if (wValueNode && wValueNode.type === 'object') {
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
                                    }
                                }
                            }
                        }

                        if (wBodyNode) {
                            const watchKey = `watch:${wKeyName}`;
                            const { calls, assigns } = this.extractCallsAndAssignments(wBodyNode);
                            methods.set(watchKey, {
                                name: `watch('${wKeyName}')`,
                                calls,
                                assignments: assigns,
                                start: watchChild.startIndex,
                                end: watchChild.endIndex,
                                isWatcher: true,
                                watchTarget: wKeyName,
                            });
                        }
                    }
                }
            }
        }

        return { methods, dataInitialValues };
    }

    /**
     * Extract method calls (this.xxx()) and assignments (this.xxx = ...) from a block node.
     */
    private extractCallsAndAssignments(blockNode: any): {
        calls: { methodName: string; start: number; end: number }[];
        assigns: { variableName: string; fullExpression: string; start: number; end: number }[];
    } {
        const calls: { methodName: string; start: number; end: number }[] = [];
        const assigns: { variableName: string; fullExpression: string; start: number; end: number }[] = [];

        const walk = (node: any) => {
            if (!node) return;

            if (node.type === 'call_expression') {
                const funcNode = node.childForFieldName('function');
                if (funcNode && funcNode.type === 'member_expression') {
                    const objNode = funcNode.childForFieldName('object');
                    const propNode = funcNode.childForFieldName('property');
                    if (objNode && objNode.text === 'this' && propNode) {
                        calls.push({
                            methodName: propNode.text,
                            start: node.startIndex,
                            end: node.endIndex,
                        });
                    }
                }
            }

            if (node.type === 'assignment_expression') {
                const leftNode = node.childForFieldName('left');
                if (leftNode && leftNode.type === 'member_expression') {
                    const objNode = leftNode.childForFieldName('object');
                    const propNode = leftNode.childForFieldName('property');
                    if (objNode && objNode.text === 'this' && propNode) {
                        assigns.push({
                            variableName: propNode.text,
                            fullExpression: node.text,
                            start: node.startIndex,
                            end: node.endIndex,
                        });
                    }
                }
            }

            if (node.children && Array.isArray(node.children)) {
                for (const child of node.children) {
                    walk(child);
                }
            }
        };

        walk(blockNode);
        return { calls, assigns };
    }

    /**
     * Find the byte offset after the last import statement in script content.
     * If there are no imports, returns 0 (insert at start).
     */
    public async findLastImportEndOffset(scriptContent: string): Promise<number> {
        const tree = await this.parseWithCache('typescript', scriptContent);
        if (!tree) return 0;

        const root = tree.rootNode;
        let lastImportEnd = 0;

        for (const child of root.children) {
            if (child.type === 'import_statement') {
                lastImportEnd = child.endIndex;
            }
        }

        return lastImportEnd;
    }

    /**
     * Find where to insert a component registration in the Vue Options API.
     * Returns:
     *  - type: 'existing' — components:{} already exists, insertOffset is before the closing }
     *  - type: 'new' — no components:{}, insertOffset is after the opening { of export default {}
     *  - null — no export default found
     */
    public async findComponentsInsertInfo(
        scriptContent: string
    ): Promise<{ type: 'existing' | 'new'; insertOffset: number } | null> {
        const tree = await this.parseWithCache('typescript', scriptContent);
        if (!tree) return null;

        const root = tree.rootNode;
        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return null;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return null;

        // Look for existing `components` property
        for (const child of objectNode.children) {
            if (child.type === 'pair' || child.type === 'method_definition') {
                const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
                if (keyNode && keyNode.text === 'components') {
                    const valueNode = child.childForFieldName('value');
                    if (valueNode && valueNode.type === 'object') {
                        // Insert before the closing }
                        const closeBrace = valueNode.endIndex - 1;
                        return { type: 'existing', insertOffset: closeBrace };
                    }
                }
            }
        }

        // No components found — insert after the opening { of the export default object
        return { type: 'new', insertOffset: objectNode.startIndex + 1 };
    }

    /**
     * Find insertion info for a Vue Options section (data / methods).
     *
     * Returns:
     *  - type: 'existing' — section exists, insertOffset is before its closing }
     *  - type: 'new' — section does not exist, insertOffset is after the opening { of export default {}
     *  - null — no export default found
     */
    public async findOptionSectionInsertInfo(
        scriptContent: string,
        section: 'data' | 'methods'
    ): Promise<{ type: 'existing' | 'new'; insertOffset: number; objectOpenOffset?: number } | null> {
        const tree = await this.parseWithCache('typescript', scriptContent);
        if (!tree) return null;

        const root = tree.rootNode;
        const exportStmt = this.findNodeByType(root, 'export_statement');
        if (!exportStmt) return null;

        const objectNode = this.findNodeByType(exportStmt, 'object');
        if (!objectNode) return null;

        for (const child of objectNode.children) {
            if (child.type !== 'pair' && child.type !== 'method_definition') continue;

            const keyNode = child.childForFieldName('key') || child.childForFieldName('name');
            if (!keyNode || keyNode.text !== section) continue;

            if (section === 'data') {
                // data() { return { ... } }  — find the return object's closing }
                const returnObj = this.findDataReturnObject(child);
                if (returnObj) {
                    return {
                        type: 'existing',
                        insertOffset: returnObj.endIndex - 1,
                        objectOpenOffset: returnObj.startIndex + 1,
                    };
                }
            } else {
                // methods: { ... }  — find the value object's closing }
                const valueNode = child.childForFieldName('value');
                if (valueNode && valueNode.type === 'object') {
                    return {
                        type: 'existing',
                        insertOffset: valueNode.endIndex - 1,
                        objectOpenOffset: valueNode.startIndex + 1,
                    };
                }
            }
        }

        // Section not found — insert after opening { of export default
        return { type: 'new', insertOffset: objectNode.startIndex + 1 };
    }
}
