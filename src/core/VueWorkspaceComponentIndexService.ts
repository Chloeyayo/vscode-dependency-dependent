import * as path from "path";
import * as vscode from "vscode";
import { NATIVE_HTML_TAGS } from "./htmlTags";

function fileNameToComponentName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .replace(/-(\w)/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

function toKebabCase(name: string): string {
  return name.replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : `-${c.toLowerCase()}`));
}

function isIgnoredVueFile(uri: vscode.Uri): boolean {
  const normalized = uri.fsPath.replace(/\\/g, "/");
  return normalized.includes("/node_modules/")
    || normalized.includes("/.git/")
    || normalized.includes("/dist/")
    || normalized.includes("/out/");
}

export interface VueWorkspaceComponentInfo {
  uri: vscode.Uri;
  componentName: string;
  kebabName: string;
  nameLower: string;
  kebabLower: string;
}

interface WorkspaceVueIndexState {
  files: Map<string, vscode.Uri>;
  components: Map<string, VueWorkspaceComponentInfo>;
  initialized: boolean;
  initPromise?: Promise<void>;
  watcher: vscode.FileSystemWatcher;
}

function buildComponentInfo(fsPath: string, uri: vscode.Uri): VueWorkspaceComponentInfo | null {
  const componentName = fileNameToComponentName(fsPath);
  if (!componentName) {
    return null;
  }
  if (NATIVE_HTML_TAGS.has(componentName.toLowerCase())) {
    return null;
  }

  const kebabName = toKebabCase(componentName);
  return {
    uri,
    componentName,
    kebabName,
    nameLower: componentName.toLowerCase(),
    kebabLower: kebabName.toLowerCase(),
  };
}

export class VueWorkspaceComponentIndexService implements vscode.Disposable {
  private readonly workspaceStates = new Map<string, WorkspaceVueIndexState>();

  public dispose(): void {
    for (const state of this.workspaceStates.values()) {
      state.watcher.dispose();
    }
    this.workspaceStates.clear();
  }

  public async getComponents(documentUri: vscode.Uri): Promise<ReadonlyArray<VueWorkspaceComponentInfo>> {
    const workspace = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspace) {
      return [];
    }

    const state = this.getWorkspaceState(workspace);
    await this.ensureWorkspaceIndexed(workspace, state);
    return Array.from(state.components.values());
  }

  private getWorkspaceState(workspace: vscode.WorkspaceFolder): WorkspaceVueIndexState {
    const key = workspace.uri.toString();
    const cached = this.workspaceStates.get(key);
    if (cached) {
      return cached;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspace, "**/*.vue"),
      false,
      false,
      false,
    );

    const state: WorkspaceVueIndexState = {
      files: new Map<string, vscode.Uri>(),
      components: new Map<string, VueWorkspaceComponentInfo>(),
      initialized: false,
      watcher,
    };

    watcher.onDidCreate((uri) => {
      if (isIgnoredVueFile(uri)) {
        return;
      }

      const normalized = vscode.Uri.file(uri.fsPath).fsPath;
      state.files.set(normalized, uri);
      const info = buildComponentInfo(normalized, uri);
      if (info) {
        state.components.set(normalized, info);
      }
    });

    watcher.onDidDelete((uri) => {
      const normalized = vscode.Uri.file(uri.fsPath).fsPath;
      state.files.delete(normalized);
      state.components.delete(normalized);
    });

    watcher.onDidChange((uri) => {
      if (isIgnoredVueFile(uri)) {
        return;
      }

      const normalized = vscode.Uri.file(uri.fsPath).fsPath;
      if (state.files.has(normalized)) {
        state.files.set(normalized, uri);
      }
    });

    this.workspaceStates.set(key, state);
    return state;
  }

  private async ensureWorkspaceIndexed(
    workspace: vscode.WorkspaceFolder,
    state: WorkspaceVueIndexState,
  ): Promise<void> {
    if (state.initialized) {
      return;
    }
    if (state.initPromise) {
      return state.initPromise;
    }

    state.initPromise = (async () => {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspace, "**/*.vue"),
        "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}",
      );

      for (const file of files) {
        if (isIgnoredVueFile(file)) {
          continue;
        }

        const normalized = vscode.Uri.file(file.fsPath).fsPath;
        state.files.set(normalized, file);
        const info = buildComponentInfo(normalized, file);
        if (info) {
          state.components.set(normalized, info);
        }
      }

      state.initialized = true;
    })().finally(() => {
      state.initPromise = undefined;
    });

    return state.initPromise;
  }
}
