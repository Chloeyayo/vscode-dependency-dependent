import * as path from "node:path";
import * as vscode from "vscode";
import { DepService } from "../DepService";
import { getLoading, getLocked } from "../core/context";
import getRelativePath from "../core/getRelativePath";
import { log } from "../extension";

const rootViewItemId = "dependency-dependent-DepExplorerView-root-viewItem";

let depExplorerView: DepExplorerView;

export enum DepTypeEnum {
  Root = "Root",
  Dependency = "Dependency",
  Dependent = "Dependent",
}

export class DepTreeItem extends vscode.TreeItem {
  depType: DepTypeEnum = DepTypeEnum.Dependency;
  depUri: vscode.Uri | undefined;
}

export default class DepExplorerView
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  static get singleton() {
    return depExplorerView;
  }

  public static viewId = "dependency-dependent-DepExplorerView";

  protected treeView: vscode.TreeView<DepTreeItem>;

  protected currentRootUri?: vscode.Uri;

  protected _onDidChangeTreeData: vscode.EventEmitter<any> =
    new vscode.EventEmitter<any>();
  readonly onDidChangeTreeData: vscode.Event<any> =
    this._onDidChangeTreeData.event;

  constructor(context: vscode.ExtensionContext) {
    depExplorerView = this;

    this.treeView = vscode.window.createTreeView(DepExplorerView.viewId, {
      treeDataProvider: this,
      showCollapseAll: true,
    });

    context.subscriptions.push(this._onDidChangeTreeData);
    context.subscriptions.push(this.treeView);
  }

  dispose() {
    this._onDidChangeTreeData.dispose();
    this.treeView.dispose();
    depExplorerView = undefined!;
  }

  public refresh() {
    this._onDidChangeTreeData.fire(null);
  }

  public setTreeViewMessage(msg: string) {
    const messages: string[] = [];

    if (getLoading() === true) {
      messages.push("Loading...");
    }

    if (msg) {
      messages.push(msg);
    }

    this.treeView.message = messages.join("\n");
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(
    element?: DepTreeItem
  ): DepTreeItem[] | null | Thenable<DepTreeItem[] | null> {
    if (!element) {
      return this.getTreeRoot();
    }

    if (element.depType === DepTypeEnum.Root) {
      return this.getSubTreeItems(element);
    }

    return this.getTreeElement(element);
  }

  protected getTreeElement = async (element: DepTreeItem) => {
    if (!element.depUri) {
      return [];
    }

    const workspace = vscode.workspace.getWorkspaceFolder(element.depUri);

    if (element.depType === DepTypeEnum.Dependency) {
      const dependencyMap = await DepService.singleton.getDependencyMapByWorkspace(
        workspace
      );
      const dependencies =
        dependencyMap.get(element.depUri.fsPath) || new Set<string>();
      const items: DepTreeItem[] = [];

      for (const dependency of dependencies) {
        const uri = vscode.Uri.file(dependency);
        const item = new DepTreeItem(uri);
        
        // Optimally check for children using the map directly
        const hasChildren = 
          dependencyMap.has(uri.fsPath) && 
          dependencyMap.get(uri.fsPath)!.size > 0;

        item.depUri = uri;
        
        // Smart Label for index files
        const basename = path.basename(uri.fsPath);
        if (basename.startsWith("index.")) {
          const dirname = path.basename(path.dirname(uri.fsPath));
          item.label = dirname;
          item.description = `${basename} • ${getRelativePath(element.depUri, item.depUri)}`;
        } else {
          item.description = getRelativePath(element.depUri, item.depUri);
        }

        item.command = {
          title: "open",
          command: "vscode.open",
          arguments: [item.depUri],
        };

        if (hasChildren) {
          item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
          item.iconPath = vscode.ThemeIcon.File;
        }

        item.depType = DepTypeEnum.Dependency;

        items.push(item);
      }

      return items;
    } else {
      const dependentMap = await DepService.singleton.getDependentMapByWorkspace(
        workspace
      );
      const dependents =
        dependentMap.get(element.depUri.fsPath) || new Set<string>();
      const items: DepTreeItem[] = [];

      for (const dependent of dependents) {
        const uri = vscode.Uri.file(dependent);
        const item = new DepTreeItem(uri);
        
        // Optimally check for children using the map directly
        const hasChildren = 
          dependentMap.has(uri.fsPath) && 
          dependentMap.get(uri.fsPath)!.size > 0;

        item.depUri = uri;

        // Smart Label for index files
        const basename = path.basename(uri.fsPath);
        if (basename.startsWith("index.")) {
          const dirname = path.basename(path.dirname(uri.fsPath));
          item.label = dirname;
          item.description = `${basename} • ${getRelativePath(element.depUri, item.depUri)}`;
        } else {
          item.description = getRelativePath(element.depUri, item.depUri);
        }

        item.command = {
          title: "open",
          command: "dependency-dependent.openAndReveal",
          arguments: [item.depUri.fsPath, element.depUri.fsPath],
        };

        if (hasChildren) {
          item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
          item.iconPath = vscode.ThemeIcon.File;
        }

        item.depType = DepTypeEnum.Dependent;

        items.push(item);
      }

      return items;
    }
  };

  protected async getTreeRoot() {
    try {
      let uri: vscode.Uri | undefined;

      const locked = getLocked();
      if (locked === true && this.currentRootUri) {
        uri = this.currentRootUri;
      } else {
        uri = vscode.window.activeTextEditor?.document?.uri;

        if (!uri) {
          throw new Error("Can't get uri of activeTextEditor.");
        }

        this.currentRootUri = uri;
      }

      const dependencies = await DepService.singleton.getDependencies(uri);
      const dependents = await DepService.singleton.getDependents(uri);

      if (!dependencies.length && !dependents.length) {
        throw new Error("No dependency or dependent found.");
      }

      const workspaceUri = vscode.workspace.getWorkspaceFolder(uri)?.uri;

      this.setTreeViewMessage("");
      const rootTreeItem = new DepTreeItem(uri);

      if (workspaceUri) {
        const description = path
          .relative(workspaceUri.fsPath, uri.fsPath)
          .replaceAll(path.sep, "/");

        rootTreeItem.description = description;
      }

      rootTreeItem.depType = DepTypeEnum.Root;
      rootTreeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      rootTreeItem.depUri = uri;
      rootTreeItem.command = {
        title: "open",
        command: "vscode.open",
        arguments: [rootTreeItem.depUri],
      };
      rootTreeItem.contextValue = rootViewItemId;

      return [rootTreeItem];
    } catch (e: any) {
      this.setTreeViewMessage(
        "No dependency or dependent found for this file.\n Please check config, see https://github.com/zjffun/vscode-dependency-dependent"
      );
      log.appendLine(e.message);
      return null;
    }
  }

  protected async getSubTreeItems(element: DepTreeItem) {
    const dependencyTreeItem = new DepTreeItem(
      vscode.l10n.t("Dependencies")
    );
    dependencyTreeItem.depType = DepTypeEnum.Dependency;
    dependencyTreeItem.collapsibleState =
      vscode.TreeItemCollapsibleState.Expanded;
    dependencyTreeItem.depUri = element.depUri;

    const dependentTreeItem = new DepTreeItem(
      vscode.l10n.t("Dependents")
    );
    dependentTreeItem.depType = DepTypeEnum.Dependent;
    dependentTreeItem.collapsibleState =
      vscode.TreeItemCollapsibleState.Expanded;
    dependentTreeItem.depUri = element.depUri;

    return [dependentTreeItem, dependencyTreeItem];
  }
}
