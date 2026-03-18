import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { glob } from "glob";
import { ResolverFactory, CachedInputFileSystem } from "enhanced-resolve";

import { TreeSitterParser } from "./TreeSitterParser";
import { log } from "../extension";
import { DepMap } from "..";
import { DepService } from "../DepService";

/**
 * Incremental Dependency Graph.
 *
 * Maintains a live adjacency list of file dependencies.
 * On file change, only that file is re-parsed and its edges updated.
 */
export class DependencyGraph {
  /** file -> set of files it imports */
  private dependencyMap: DepMap = new Map();

  /** file -> set of files that import it */
  private dependentMap: DepMap = new Map();

  /** The enhanced-resolve resolver instance */
  private resolver: any;

  /** The workspace root path */
  public readonly workspaceRoot: string;

  /** Whether the initial full scan has been completed */
  private initialized = false;

  /** Promise tracking the current initialization */
  private initPromise: Promise<void> | null = null;

  /** Interval for purging CachedInputFileSystem */
  private purgeInterval: ReturnType<typeof setInterval> | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Initialize the resolver with webpack alias configuration.
   */
  async initResolver() {
    let resolveConfig: any = {
      extensions: [".js", ".jsx", ".ts", ".tsx", ".vue", ".json"],
      alias: {},
    };

    try {
      const webpackConfigFn = await DepService.getWebpackConfigFn();
      if (typeof webpackConfigFn === "function") {
        const dummyConfig = { resolve: { alias: {}, extensions: [] } };
        const result = webpackConfigFn(dummyConfig);
        if (result?.resolve) {
          resolveConfig = {
            ...resolveConfig,
            ...result.resolve,
            extensions: result.resolve.extensions || resolveConfig.extensions,
            alias: result.resolve.alias || resolveConfig.alias,
          };
        }
      }
    } catch (e: any) {
      log.appendLine(`DependencyGraph: Error loading webpack config: ${e.message}`);
    }

    // Default alias fallback
    if (!resolveConfig.alias || Object.keys(resolveConfig.alias).length === 0) {
      resolveConfig.alias = {
        "@": path.join(this.workspaceRoot, "src"),
      };
    }

    this.resolver = ResolverFactory.createResolver({
      fileSystem: new CachedInputFileSystem(fs as any, 4000),
      extensions: resolveConfig.extensions,
      alias: resolveConfig.alias,
      modules: resolveConfig.modules || ["node_modules"],
      preferRelative: true,
    });

    // Periodically purge the file system cache to prevent memory accumulation
    // in long-running sessions with large projects
    if (!this.purgeInterval) {
      this.purgeInterval = setInterval(() => {
        if (this.resolver?.fileSystem?.purge) {
          this.resolver.fileSystem.purge();
        }
      }, 30_000);
    }
  }

  /**
   * Full initialization: scan all entry-point files and build the graph.
   * Shows progress in the VS Code window.
   */
  async initialize(entryPatterns: string[], excludes: string[]): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        await this._doInitialize(entryPatterns, excludes);
        this.initialized = true;
      } catch (e) {
        this.initialized = false;
        throw e;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  private async _doInitialize(entryPatterns: string[], excludes: string[]): Promise<void> {
    await this.initResolver();

    // Discover all files matching entry patterns
    const globPromises = entryPatterns.map((pattern) =>
      glob(pattern, {
        cwd: this.workspaceRoot,
        absolute: true,
        ignore: excludes.map((e) => `**/${e}/**`),
      })
    );

    const globResults = await Promise.all(globPromises);
    const allFiles = [...new Set(globResults.flat())];

    log.appendLine(
      `DependencyGraph: Found ${allFiles.length} files to scan.`
    );

    // Parse each file (parallel with concurrency limit)
    const CONCURRENCY = 10;
    let processed = 0;
    for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
      const batch = allFiles.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((filePath) => this.processFile(filePath)));
      processed += batch.length;

      // Log progress every 100 files
      if (processed % 100 < CONCURRENCY) {
        log.appendLine(
          `DependencyGraph: Processed ${processed}/${allFiles.length} files...`
        );
      }
    }

    log.appendLine(
      `DependencyGraph: Initialization complete. ${this.dependencyMap.size} nodes in graph.`
    );
  }

  /**
   * Process a single file: parse it, resolve its imports, update the graph.
   * Can be called for both initial scan and incremental updates.
   */
  async processFile(filePath: string): Promise<void> {
    const normalizedPath = vscode.Uri.file(filePath).fsPath;

    // Read file content (async to avoid blocking extension host)
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      // File might have been deleted
      this.removeFile(normalizedPath);
      return;
    }

    // Extract import sources
    let importSources: string[];
    try {
      importSources = await TreeSitterParser.getInstance().extractImports(content, filePath);
    } catch (e: any) {
      log.appendLine(`DependencyGraph: Error extracting imports from ${filePath}: ${e.message}`);
      log.appendLine(`Stack: ${e.stack}`);
      return;
    }

    // Resolve all imports in parallel (enhanced-resolve supports concurrent resolution)
    const resolvedDeps = new Set<string>();
    const resolutions = await Promise.all(
      importSources.map((source) =>
        this.resolvePath(path.dirname(filePath), source)
      )
    );
    for (const resolved of resolutions) {
      if (resolved) {
        resolvedDeps.add(resolved);
      }
    }

    // Parse/resolve completed successfully; now atomically replace old edges
    this.removeFileEdges(normalizedPath);

    // Update dependency map
    this.dependencyMap.set(normalizedPath, resolvedDeps);

    // Update dependent map (reverse edges)
    for (const dep of resolvedDeps) {
      let dependents = this.dependentMap.get(dep);
      if (!dependents) {
        dependents = new Set();
        this.dependentMap.set(dep, dependents);
      }
      dependents.add(normalizedPath);
    }
  }

  /**
   * Remove all edges originating from a file.
   * Used before re-processing a file to ensure stale edges are cleaned up.
   */
  private removeFileEdges(filePath: string) {
    const oldDeps = this.dependencyMap.get(filePath);
    if (oldDeps) {
      for (const dep of oldDeps) {
        const dependents = this.dependentMap.get(dep);
        if (dependents) {
          dependents.delete(filePath);
          if (dependents.size === 0) {
            this.dependentMap.delete(dep);
          }
        }
      }
    }
    this.dependencyMap.delete(filePath);
  }

  /**
   * Completely remove a file from the graph (e.g., on file deletion).
   */
  removeFile(filePath: string) {
    this.removeFileEdges(filePath);

    // Also remove it as a dependent target
    const dependents = this.dependentMap.get(filePath);
    if (dependents) {
      this.dependentMap.delete(filePath);
    }
  }

  /**
   * Resolve an import source (e.g., './foo', '@/utils') to an absolute path.
   */
  public resolvePath(
    contextDir: string,
    request: string
  ): Promise<string | null> {
    if (!this.resolver) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      this.resolver.resolve(
        {},
        contextDir,
        request,
        {},
        (err: any, filepath: string) => {
          if (err || !filepath) {
            resolve(null);
            return;
          }
          resolve(vscode.Uri.file(filepath).fsPath);
        }
      );
    });
  }

  // --- Public API ---

  getDependencies(filePath: string): Set<string> {
    return this.dependencyMap.get(filePath) || new Set();
  }

  getDependents(filePath: string): Set<string> {
    return this.dependentMap.get(filePath) || new Set();
  }

  getDependencyMap(): DepMap {
    return this.dependencyMap;
  }

  getDependentMap(): DepMap {
    return this.dependentMap;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  dispose() {
    if (this.purgeInterval) {
      clearInterval(this.purgeInterval);
      this.purgeInterval = null;
    }

    if (this.resolver?.fileSystem?.purge) {
      this.resolver.fileSystem.purge();
    }
    this.resolver = null;

    this.dependencyMap.clear();
    this.dependentMap.clear();
    this.initialized = false;
    this.initPromise = null;
  }
}
