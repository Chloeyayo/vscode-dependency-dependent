import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  TreeSitterParser,
  type VueOptionsIndex,
} from "./TreeSitterParser";
import {
  getRootTemplateBounds,
  type RootTemplateBounds,
} from "./vueTemplateUtils";

export interface VueOptionPropertyEntry {
  name: string;
  source: string;
  inferredType?: string;
}

export interface VueScriptInfoSnapshot {
  scriptContent: string;
  scriptOffset: number;
}

export interface VueDocumentModel {
  uri?: vscode.Uri;
  filePath: string;
  version: number | null;
  text: string;
  templateBounds: RootTemplateBounds | null;
  scriptInfo: VueScriptInfoSnapshot | null;
  importedComponentNames: ReadonlySet<string>;
  getVueOptionsIndex(): Promise<VueOptionsIndex>;
  getVueOptionProperties(): Promise<VueOptionPropertyEntry[]>;
}

class CachedVueDocumentModel implements VueDocumentModel {
  private templateBoundsValue: RootTemplateBounds | null = null;
  private templateBoundsResolved = false;
  private scriptInfoValue: VueScriptInfoSnapshot | null = null;
  private scriptInfoResolved = false;
  private importedComponentNamesValue: ReadonlySet<string> = new Set<string>();
  private importedComponentNamesResolved = false;
  private vueOptionsIndexPromise?: Promise<VueOptionsIndex>;
  private vueOptionPropertiesPromise?: Promise<VueOptionPropertyEntry[]>;

  constructor(
    private readonly treeSitterParser: TreeSitterParser,
    public readonly filePath: string,
    public readonly text: string,
    public readonly version: number | null,
    public readonly uri?: vscode.Uri,
  ) {}

  public get templateBounds(): RootTemplateBounds | null {
    if (!this.templateBoundsResolved) {
      this.templateBoundsValue = getRootTemplateBounds(this.text);
      this.templateBoundsResolved = true;
    }
    return this.templateBoundsValue;
  }

  public get scriptInfo(): VueScriptInfoSnapshot | null {
    if (!this.scriptInfoResolved) {
      this.scriptInfoValue = this.treeSitterParser.extractVueScriptInfo(this.text);
      this.scriptInfoResolved = true;
    }
    return this.scriptInfoValue;
  }

  public get importedComponentNames(): ReadonlySet<string> {
    if (!this.importedComponentNamesResolved) {
      this.importedComponentNamesValue = this.collectImportedComponentNames();
      this.importedComponentNamesResolved = true;
    }
    return this.importedComponentNamesValue;
  }

  public getVueOptionsIndex(): Promise<VueOptionsIndex> {
    const cached = this.vueOptionsIndexPromise;
    if (cached) {
      return cached;
    }

    const promise = this.treeSitterParser.getVueOptionsIndex(this.text).catch((error) => {
      if (this.vueOptionsIndexPromise === promise) {
        this.vueOptionsIndexPromise = undefined;
      }
      throw error;
    });
    this.vueOptionsIndexPromise = promise;
    return promise;
  }

  public getVueOptionProperties(): Promise<VueOptionPropertyEntry[]> {
    const cached = this.vueOptionPropertiesPromise;
    if (cached) {
      return cached;
    }

    const promise = this.getVueOptionsIndex()
      .then((index) => index.properties.map(({ name, source, inferredType }) => ({
        name,
        source,
        inferredType,
      })))
      .catch((error) => {
        if (this.vueOptionPropertiesPromise === promise) {
          this.vueOptionPropertiesPromise = undefined;
        }
        throw error;
      });
    this.vueOptionPropertiesPromise = promise;
    return promise;
  }

  private collectImportedComponentNames(): ReadonlySet<string> {
    const names = new Set<string>();
    const scriptContent = this.scriptInfo?.scriptContent ?? "";
    const importRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/g;

    let match: RegExpExecArray | null;
    while ((match = importRe.exec(scriptContent)) !== null) {
      names.add(match[1]);
    }

    return names;
  }
}

interface DocumentCacheEntry {
  version: number;
  model: CachedVueDocumentModel;
}

interface FileCacheEntry {
  fingerprint: string;
  model: CachedVueDocumentModel;
}

export class VueDocumentModelManager {
  private static _instance: VueDocumentModelManager | undefined;
  private static readonly DOCUMENT_CACHE_MAX = 120;
  private static readonly FILE_CACHE_MAX = 200;

  private readonly treeSitterParser: TreeSitterParser;
  private readonly documentCache = new Map<string, DocumentCacheEntry>();
  private readonly fileCache = new Map<string, FileCacheEntry>();

  private constructor() {
    this.treeSitterParser = TreeSitterParser.getInstance();
  }

  public static getInstance(): VueDocumentModelManager {
    if (!this._instance) {
      this._instance = new VueDocumentModelManager();
    }
    return this._instance;
  }

  public getDocumentModel(document: vscode.TextDocument): VueDocumentModel {
    const key = document.uri.toString();
    const cached = this.documentCache.get(key);
    if (cached && cached.version === document.version) {
      this.touchDocumentEntry(key, cached);
      return cached.model;
    }

    const model = new CachedVueDocumentModel(
      this.treeSitterParser,
      document.fileName,
      document.getText(),
      document.version,
      document.uri,
    );
    const entry: DocumentCacheEntry = { version: document.version, model };
    this.touchDocumentEntry(key, entry);
    this.evictOverflow(this.documentCache, VueDocumentModelManager.DOCUMENT_CACHE_MAX);
    return model;
  }

  public async getFileModel(filePath: string): Promise<VueDocumentModel | null> {
    const normalizedPath = path.normalize(filePath);

    const opened = vscode.workspace.textDocuments.find(
      (doc) => path.normalize(doc.fileName) === normalizedPath,
    );
    if (opened) {
      return this.getDocumentModel(opened);
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(normalizedPath);
    } catch {
      return null;
    }

    if (!stat.isFile()) {
      return null;
    }

    const fingerprint = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.fileCache.get(normalizedPath);
    if (cached && cached.fingerprint === fingerprint) {
      this.touchFileEntry(normalizedPath, cached);
      return cached.model;
    }

    let text: string;
    try {
      text = await fs.promises.readFile(normalizedPath, "utf8");
    } catch {
      return null;
    }

    const model = new CachedVueDocumentModel(
      this.treeSitterParser,
      normalizedPath,
      text,
      null,
    );
    const entry: FileCacheEntry = { fingerprint, model };
    this.touchFileEntry(normalizedPath, entry);
    this.evictOverflow(this.fileCache, VueDocumentModelManager.FILE_CACHE_MAX);
    return model;
  }

  private touchDocumentEntry(key: string, entry: DocumentCacheEntry): void {
    this.documentCache.delete(key);
    this.documentCache.set(key, entry);
  }

  private touchFileEntry(key: string, entry: FileCacheEntry): void {
    this.fileCache.delete(key);
    this.fileCache.set(key, entry);
  }

  private evictOverflow<T>(cache: Map<string, T>, limit: number): void {
    while (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }
}
