import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ResolverFactory, CachedInputFileSystem } from "enhanced-resolve";
import { DepService } from "../DepService";
import { TreeSitterParser } from "../core/TreeSitterParser";

import { log } from "../extension";

export class WebpackDefinitionProvider implements vscode.DefinitionProvider {
  private resolver: any;
  private lastWorkspace: string | undefined;
  private treeSitterParser: TreeSitterParser;

  constructor() {
    this.treeSitterParser = TreeSitterParser.getInstance();
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {

    const fileContent = document.getText();
    const offset = document.offsetAt(position);
    const filePath = document.uri.fsPath;

    let request: string | undefined;

    // Strategy 1: Check if cursor is inside an import/require string
    try {
      const importSource = await this.treeSitterParser.findImportSourceAtPosition(
        fileContent,
        filePath,
        offset
      );
      if (importSource) {
        request = importSource;
      }
    } catch (e) {
      log.appendLine(`TreeSitter findImportSourceAtPosition error: ${e}`);
    }

    // Strategy 2: If not in quotes, check if it's a Vue component tag
    if (!request) {
      // Allow words with hyphens (kebab-case)
      const range = document.getWordRangeAtPosition(position, /[\w-]+/);
      if (range) {
        const word = document.getText(range);

        // Check if it looks like a component tag (kebab-case or PascalCase)
        // Must start with a letter.
        if (/^[a-zA-Z][\w-]*$/.test(word)) {
          // Convert kebab-case to PascalCase
          // e.g. operation-dialog -> OperationDialog
          // e.g. MyComponent -> MyComponent
          const pascalCase = word
            .replace(/-(\w)/g, (_, c) => c.toUpperCase())
            .replace(/^[a-z]/, (c) => c.toUpperCase());

          // Find import for this component using TreeSitter
          try {
            const importPath = await this.treeSitterParser.findImportPathForIdentifier(
              fileContent,
              filePath,
              pascalCase
            );
            if (importPath) {
              request = importPath;
            }
          } catch (e) {
            log.appendLine(`TreeSitter findImportPathForIdentifier error: ${e}`);
          }
        }
      }
    }

    if (!request) {
      return undefined;
    }

    // Heuristic: check if it looks like a path or alias
    if (
      !request.startsWith(".") &&
      !request.startsWith("/") &&
      !request.startsWith("@") &&
      !request.startsWith("~")
    ) {
      // It might be a node_module or simple alias, let's try resolving it anyway
    }

    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspace) return undefined;

    // Initialize Resolver
    if (!this.resolver || this.lastWorkspace !== workspace.uri.fsPath) {
      await this.initResolver(workspace);
    }

    if (!this.resolver) return undefined;

    if (token.isCancellationRequested) return undefined;

    return new Promise((resolve) => {
      this.resolver.resolve(
        {},
        path.dirname(document.uri.fsPath),
        request,
        {},
        (err: any, filepath: string) => {
          if (err) {
            log.appendLine(`Resolve error: ${err}`);
            resolve(undefined);
            return;
          }
          if (!filepath) {
            resolve(undefined);
            return;
          }
          const uri = vscode.Uri.file(filepath);
          resolve(new vscode.Location(uri, new vscode.Position(0, 0)));
        }
      );
    });
  }

  private async initResolver(workspace: vscode.WorkspaceFolder) {
    this.lastWorkspace = workspace.uri.fsPath;

    // Purge old resolver's cached file system before creating a new one
    if (this.resolver?.fileSystem?.purge) {
      this.resolver.fileSystem.purge();
    }

    const webpackConfigFn = await DepService.getWebpackConfigFn();
    let resolveConfig: any = {
      extensions: [".js", ".jsx", ".ts", ".tsx", ".vue", ".json"],
      alias: {},
    };

    if (typeof webpackConfigFn === "function") {
      try {
        // Pass a dummy config to capture modifications
        const dummyConfig = { resolve: { alias: {}, extensions: [] } };
        const result = webpackConfigFn(dummyConfig);

        if (result && result.resolve) {
          resolveConfig = {
            ...resolveConfig,
            ...result.resolve,
            // Merge extensions if present
            extensions: result.resolve.extensions || resolveConfig.extensions,
            alias: result.resolve.alias || resolveConfig.alias,
          };
        }
      } catch (e) {
        console.error("Error loading webpack config for definition provider", e);
      }
    }

    // Default alias fallback if none provided
    if (!resolveConfig.alias || Object.keys(resolveConfig.alias).length === 0) {
      resolveConfig.alias = {
        "@": path.join(workspace.uri.fsPath, "src"),
      };
      log.appendLine("Using default alias: @ -> src");
    }

    this.resolver = ResolverFactory.createResolver({
      fileSystem: new CachedInputFileSystem(fs as any, 4000),
      extensions: resolveConfig.extensions,
      alias: resolveConfig.alias,
      modules: resolveConfig.modules || ["node_modules"],
      preferRelative: true,
    });
  }
}
