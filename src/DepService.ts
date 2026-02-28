import * as vscode from "vscode";
import { glob } from "glob";
import { DepMap } from ".";
import { DependencyGraph } from "./core/DependencyGraph";
import { log } from "./extension";
import { webpackConfigFileName } from "./share";

let singletonInstance: DepService;

export class DepService {
  static get singleton() {
    if (!singletonInstance) {
      singletonInstance = new DepService();
    }
    return singletonInstance;
  }

  /** workspace fsPath -> DependencyGraph */
  private graphs = new Map<string, DependencyGraph>();

  /** FileSystemWatcher subscription */
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor() {}

  dispose() {
    for (const graph of this.graphs.values()) {
      graph.dispose();
    }
    this.graphs.clear();
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = undefined;
    }
    singletonInstance = undefined!;
  }

  // ─── Public API ────────────────────────────────────────────

  async getDependencies(uri?: vscode.Uri): Promise<string[]> {
    const fsPath = uri?.fsPath;
    if (!fsPath) {
      return [];
    }

    const graph = await this.getGraphForWorkspace(
      vscode.workspace.getWorkspaceFolder(uri)
    );
    if (!graph) {
      return [];
    }

    return [...graph.getDependencies(fsPath)];
  }

  async getDependents(uri?: vscode.Uri): Promise<string[]> {
    const fsPath = uri?.fsPath;
    if (!fsPath) {
      return [];
    }

    const graph = await this.getGraphForWorkspace(
      vscode.workspace.getWorkspaceFolder(uri)
    );
    if (!graph) {
      return [];
    }

    return [...graph.getDependents(fsPath)];
  }

  async getDependencyMapByWorkspace(
    workspace?: vscode.WorkspaceFolder,
    forceUpdate?: boolean
  ): Promise<DepMap> {
    const graph = await this.getGraphForWorkspace(workspace);
    if (!graph) {
      return new Map();
    }
    return graph.getDependencyMap();
  }

  async getDependentMapByWorkspace(
    workspace?: vscode.WorkspaceFolder,
    forceUpdate?: boolean
  ): Promise<DepMap> {
    const graph = await this.getGraphForWorkspace(workspace);
    if (!graph) {
      return new Map();
    }
    return graph.getDependentMap();
  }

  /**
   * Force a full re-scan of the active workspace.
   * Called by the "Refresh" command.
   */
  async updateActiveWorkspaceDepMap() {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri) {
      return false;
    }

    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    const fsPath = workspace?.uri?.fsPath;
    if (!fsPath) {
      return false;
    }

    // Delete existing graph to force re-initialization
    const oldGraph = this.graphs.get(fsPath);
    if (oldGraph) {
      oldGraph.dispose();
    }
    this.graphs.delete(fsPath);
    await this.getGraphForWorkspace(workspace);

    return true;
  }

  /**
   * Set up a file system watcher for incremental updates.
   */
  setupFileWatcher(context: vscode.ExtensionContext) {
    if (this.watcher) {
      return;
    }

    // Watch for changes to JS/TS/Vue files
    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{js,ts,jsx,tsx,vue}"
    );

    const handleFileChange = async (uri: vscode.Uri) => {
      const workspace = vscode.workspace.getWorkspaceFolder(uri);
      const fsPath = workspace?.uri?.fsPath;
      if (!fsPath) {
        return;
      }

      const graph = this.graphs.get(fsPath);
      if (!graph || !graph.isInitialized()) {
        return;
      }

      log.appendLine(`Incremental update: ${uri.fsPath}`);
      await graph.processFile(uri.fsPath);
    };

    const handleFileDelete = (uri: vscode.Uri) => {
      const workspace = vscode.workspace.getWorkspaceFolder(uri);
      const fsPath = workspace?.uri?.fsPath;
      if (!fsPath) {
        return;
      }

      const graph = this.graphs.get(fsPath);
      if (!graph || !graph.isInitialized()) {
        return;
      }

      log.appendLine(`File deleted, removing from graph: ${uri.fsPath}`);
      graph.removeFile(vscode.Uri.file(uri.fsPath).fsPath);
    };

    this.watcher.onDidChange(handleFileChange);
    this.watcher.onDidCreate(handleFileChange);
    this.watcher.onDidDelete(handleFileDelete);

    context.subscriptions.push(this.watcher);
  }

  // ─── Internal ──────────────────────────────────────────────

  /**
   * Get or create a DependencyGraph for a workspace.
   * Initializes the graph on first access.
   */
  private async getGraphForWorkspace(
    workspace?: vscode.WorkspaceFolder
  ): Promise<DependencyGraph | null> {
    const fsPath = workspace?.uri?.fsPath;
    if (!fsPath) {
      return null;
    }

    let graph = this.graphs.get(fsPath);
    if (graph && graph.isInitialized()) {
      return graph;
    }

    if (!graph) {
      graph = new DependencyGraph(fsPath);
      this.graphs.set(fsPath, graph);
    }

    const config = vscode.workspace.getConfiguration("dependencyDependent");
    const entryConfig = config.get<string[]>("entryPoints") || [];
    const excludesConfig = config.get<string[]>("excludes") || [];

    log.appendLine(`Initializing DependencyGraph for workspace: ${fsPath}`);
    await graph.initialize(entryConfig, excludesConfig);

    return graph;
  }

  // ─── Static Helpers (kept for WebpackDefinitionProvider compatibility) ─

  static async getEntryPoints(): Promise<string[]> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri) {
      log.appendLine("No `activeTextEditor.document.uri` found.");
      return [];
    }

    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    const cwd = workspace?.uri?.fsPath;
    if (!cwd) {
      log.appendLine("No cwd (`workspace.uri.fsPath`) found.");
      return [];
    }

    const config = vscode.workspace.getConfiguration("dependencyDependent");
    const entryConfig = config.get<string[]>("entryPoints") || [];

    const globPromises = entryConfig.map((entry) =>
      glob(entry, {
        cwd,
        absolute: true,
      })
    );

    const globResults = await Promise.all(globPromises);
    const result = globResults.flat();

    if (!result.length) {
      throw new Error("No entry points found.");
    }

    return result;
  }

  static async getWebpackConfigFn() {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri) {
      log.appendLine("No `activeTextEditor.document.uri` found.");
      return;
    }

    const workspace = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspace?.uri) {
      log.appendLine("No `workspace.uri` found.");
      return;
    }

    const webpackConfigFileUri = vscode.Uri.joinPath(
      workspace.uri,
      ".vscode",
      webpackConfigFileName
    );

    try {
      await vscode.workspace.fs.stat(webpackConfigFileUri);
    } catch {
      return;
    }

    // Only support CommonJS
    delete require.cache[require.resolve(webpackConfigFileUri.fsPath)];
    const webpackConfigFn = require(webpackConfigFileUri.fsPath);

    return webpackConfigFn;
  }
}
