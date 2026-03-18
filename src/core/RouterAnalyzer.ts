import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { glob } from "glob";

import { TreeSitterParser } from "./TreeSitterParser";
import { DependencyGraph } from "./DependencyGraph";
import { log } from "../extension";

export interface RouteDefinition {
  path: string;
  name?: string;
  componentSource: string;
  componentResolved?: string;
}

export interface NavigationCall {
  callerFile: string;
  method: "push" | "replace";
  targetType: "name" | "path";
  targetValue: string;
  line: number;
  selection: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

/**
 * Analyzes Vue Router configuration and scans workspace files for
 * `this.$router.push/replace` calls.  Builds a mapping from route-target
 * component files to the set of NavigationCalls that navigate to them.
 *
 * One instance per workspace, lazily initialized.
 */
export class RouterAnalyzer {
  private routes: RouteDefinition[] = [];
  /** name/path → NavigationCall[] */
  private navCallsByTarget = new Map<string, NavigationCall[]>();
  /** callerFile → NavigationCall[] */
  private navCallsByFile = new Map<string, NavigationCall[]>();
  /** resolved component absolute path → RouteDefinition[] */
  private componentToRoutes = new Map<string, RouteDefinition[]>();

  private routerConfigPath: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private workspaceRoot: string,
    private graph: DependencyGraph
  ) {}

  // ─── Public API ──────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await this._doInitialize();
        this.initialized = true;
      } catch (e: any) {
        log.appendLine(`RouterAnalyzer: initialization error — ${e.message}`);
        this.initialized = false;
      } finally {
        this.initPromise = null;
      }
    })();
    return this.initPromise;
  }

  /**
   * Return all NavigationCalls whose target resolves to `componentFsPath`.
   */
  getNavigationSources(componentFsPath: string): NavigationCall[] {
    const normalized = vscode.Uri.file(componentFsPath).fsPath;
    const routeDefs = this.componentToRoutes.get(normalized);
    if (!routeDefs || routeDefs.length === 0) return [];

    const uniqueCalls = new Map<string, NavigationCall>();
    for (const rd of routeDefs) {
      if (rd.name) {
        const calls = this.navCallsByTarget.get(`name:${rd.name}`);
        if (calls) {
          for (const call of calls) {
            const key = `${call.callerFile}::${call.method}::${call.targetType}::${call.targetValue}`;
            if (!uniqueCalls.has(key)) {
              uniqueCalls.set(key, call);
            }
          }
        }
      }
      if (rd.path) {
        const calls = this.navCallsByTarget.get(`path:${rd.path}`);
        if (calls) {
          for (const call of calls) {
            const key = `${call.callerFile}::${call.method}::${call.targetType}::${call.targetValue}`;
            if (!uniqueCalls.has(key)) {
              uniqueCalls.set(key, call);
            }
          }
        }
      }
    }

    return [...uniqueCalls.values()].sort((a, b) => {
      if (a.callerFile === b.callerFile) {
        return a.line - b.line;
      }
      return a.callerFile.localeCompare(b.callerFile);
    });
  }

  isRouteTarget(componentFsPath: string): boolean {
    const normalized = vscode.Uri.file(componentFsPath).fsPath;
    return this.componentToRoutes.has(normalized);
  }

  /**
   * Re-parse the router config file (called when it changes).
   */
  async refreshRouterConfig(): Promise<void> {
    this.routes = [];
    this.componentToRoutes.clear();
    await this.parseRouterConfig();
    this.rebuildComponentToRoutes();
    log.appendLine(
      `RouterAnalyzer: refreshed config — ${this.routes.length} routes`
    );
  }

  /**
   * Re-scan a single file for `$router.push/replace` calls (incremental).
   */
  async rescanFile(filePath: string): Promise<void> {
    const normalized = vscode.Uri.file(filePath).fsPath;
    this.removeNavCallsForFile(normalized);

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const calls = await this.extractNavigationCalls(normalized, content);
    if (calls.length > 0) {
      this.navCallsByFile.set(normalized, calls);
      for (const call of calls) {
        const key =
          call.targetType === "name"
            ? `name:${call.targetValue}`
            : `path:${call.targetValue}`;
        let list = this.navCallsByTarget.get(key);
        if (!list) {
          list = [];
          this.navCallsByTarget.set(key, list);
        }
        list.push(call);
      }
    }
  }

  removeFile(filePath: string): void {
    const normalized = vscode.Uri.file(filePath).fsPath;
    this.removeNavCallsForFile(normalized);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getRouterConfigPath(): string | null {
    return this.routerConfigPath;
  }

  // ─── Internals ───────────────────────────────────────────

  private async _doInitialize(): Promise<void> {
    await this.parseRouterConfig();
    this.rebuildComponentToRoutes();

    if (this.routes.length === 0) {
      log.appendLine("RouterAnalyzer: no routes found — skipping nav scan");
      return;
    }

    await this.scanAllNavigationCalls();
    log.appendLine(
      `RouterAnalyzer: initialized — ${this.routes.length} routes, ${this.navCallsByFile.size} files with nav calls`
    );
  }

  // ─── Router Config Parsing ───────────────────────────────

  private async parseRouterConfig(): Promise<void> {
    const configPath = await this.findRouterConfigPath();
    if (!configPath) {
      log.appendLine("RouterAnalyzer: no router config file found");
      return;
    }

    this.routerConfigPath = configPath;
    log.appendLine(`RouterAnalyzer: parsing router config at ${configPath}`);

    let content: string;
    try {
      content = await fs.promises.readFile(configPath, "utf-8");
    } catch {
      return;
    }

    const tsParser = TreeSitterParser.getInstance();
    const langId = tsParser.getLangId(configPath) || "javascript";
    const scriptContent =
      langId === "vue" ? this.extractVueScriptInfo(content)?.scriptContent : content;
    if (!scriptContent) return;

    const parseLang =
      langId === "vue" ? "typescript" : langId === "typescriptreact" ? "typescriptreact" : langId;
    const tree = await tsParser.parseWithCache(parseLang, scriptContent);
    if (!tree) {
      log.appendLine("RouterAnalyzer: failed to parse router config AST");
      return;
    }

    const root = tree.rootNode;

    // Build import map: identifier → source path
    const importMap = this.buildImportMap(root);
    const contextDir = path.dirname(configPath);

    // Find routes array
    const routesArray = this.findRoutesArray(root);
    if (!routesArray) {
      log.appendLine("RouterAnalyzer: could not find routes array in config");
      return;
    }

    await this.parseRouteArray(routesArray, importMap, contextDir, "");
    log.appendLine(`RouterAnalyzer: parsed ${this.routes.length} route definitions`);
  }

  private async findRouterConfigPath(): Promise<string | null> {
    // Check user configuration first
    const configuredPath = vscode.workspace
      .getConfiguration("dependencyDependent")
      .get<string>("vue.routerConfigPath");

    if (configuredPath) {
      const abs = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(this.workspaceRoot, configuredPath);
      if (fs.existsSync(abs)) return abs;
    }

    // Auto-detect common paths
    const candidates = [
      "src/router/index.js",
      "src/router/index.ts",
      "src/router.js",
      "src/router.ts",
      "router/index.js",
      "router/index.ts",
    ];

    for (const candidate of candidates) {
      const abs = path.join(this.workspaceRoot, candidate);
      if (fs.existsSync(abs)) return abs;
    }

    return null;
  }

  /**
   * Build a map of import identifier → source string from all import
   * declarations in the AST root.
   */
  private buildImportMap(root: any): Map<string, string> {
    const map = new Map<string, string>();

    for (const child of root.children) {
      if (child.type !== "import_statement") continue;

      const source = child.children.find((c: any) => c.type === "string");
      if (!source) continue;
      const sourcePath = source.text.replace(/['"]/g, "");

      // default import: import Foo from '...'
      const importClause = child.children.find(
        (c: any) => c.type === "import_clause"
      );
      if (!importClause) continue;

      for (const ic of importClause.children) {
        if (ic.type === "identifier") {
          map.set(ic.text, sourcePath);
        } else if (ic.type === "named_imports") {
          for (const spec of ic.children) {
            if (spec.type === "import_specifier") {
              const nameNode =
                spec.children.find((c: any) => c.type === "identifier") ||
                spec.children[0];
              if (nameNode) map.set(nameNode.text, sourcePath);
            }
          }
        }
      }
    }

    return map;
  }

  /**
   * Find the routes array in the AST.
   * Looks for `new VueRouter({ routes })`, `const routes = [...]`, etc.
   * Resolves identifier references to find the actual array.
   */
  private findRoutesArray(root: any): any | null {
    // Strategy 1: `new VueRouter({ routes: [...] })` or `new Router({ routes: constantRoutes })`
    const newExpr = this.findNewRouterExpression(root);
    if (newExpr) {
      const routesProp = this.findPropertyInObject(newExpr, "routes");
      if (routesProp) {
        if (routesProp.type === "array") return routesProp;
        // Identifier reference: `routes: constantRoutes` → resolve the variable
        if (routesProp.type === "identifier") {
          const resolved = this.resolveIdentifierToArray(root, routesProp.text);
          if (resolved) return resolved;
        }
      }
    }

    // Strategy 2: `const routes = [...]` or `export const routes = [...]`
    // Also try common variable names like constantRoutes, asyncRoutes
    for (const name of ["routes", "constantRoutes", "asyncRoutes"]) {
      for (const child of root.children) {
        const varDecl = this.findVariableDeclaration(child, name);
        if (varDecl?.type === "array") return varDecl;
      }
    }

    // Strategy 3: `export default [...]`
    for (const child of root.children) {
      if (child.type === "export_statement") {
        for (const c of child.children) {
          if (c.type === "array") return c;
        }
      }
    }

    return null;
  }

  /**
   * Resolve an identifier to its array declaration in the AST root.
   * e.g. `constantRoutes` → finds `const constantRoutes = [...]`
   */
  private resolveIdentifierToArray(root: any, name: string): any | null {
    for (const child of root.children) {
      const varDecl = this.findVariableDeclaration(child, name);
      if (varDecl?.type === "array") return varDecl;
    }
    return null;
  }

  private findNewRouterExpression(node: any): any | null {
    if (node.type === "new_expression") {
      const callee = node.children.find((c: any) => c.type === "identifier");
      if (
        callee &&
        (callee.text === "VueRouter" || callee.text === "Router")
      ) {
        const args = node.children.find((c: any) => c.type === "arguments");
        if (args) {
          return args.children.find((c: any) => c.type === "object");
        }
      }
    }

    for (const child of node.children || []) {
      const found = this.findNewRouterExpression(child);
      if (found) return found;
    }
    return null;
  }

  private findPropertyInObject(objNode: any, key: string): any | null {
    for (const child of objNode.children || []) {
      if (child.type === "pair" || child.type === "property") {
        const keyNode = child.children?.[0];
        if (
          keyNode &&
          (keyNode.type === "property_identifier" ||
            keyNode.type === "identifier" ||
            keyNode.type === "string") &&
          keyNode.text.replace(/['"]/g, "") === key
        ) {
          // Value is the child after the colon (skip key and ":")
          const children = child.children || [];
          for (let i = children.length - 1; i >= 1; i--) {
            const c = children[i];
            if (c.type !== ":" && c.text !== ":") {
              return c;
            }
          }
          return null;
        }
      }
      // shorthand property: `{ routes }` references a variable
      if (
        child.type === "shorthand_property_identifier_pattern" ||
        child.type === "shorthand_property_identifier"
      ) {
        if (child.text === key) return child;
      }
    }
    return null;
  }

  private findVariableDeclaration(node: any, name: string): any | null {
    if (
      node.type === "lexical_declaration" ||
      node.type === "variable_declaration"
    ) {
      for (const declarator of node.children) {
        if (
          declarator.type === "variable_declarator" &&
          declarator.children?.[0]?.text === name
        ) {
          // value is the child after `=`
          const eqIdx = declarator.children.findIndex(
            (c: any) => c.text === "="
          );
          if (eqIdx >= 0 && declarator.children[eqIdx + 1]) {
            return declarator.children[eqIdx + 1];
          }
        }
      }
    }

    // Check inside export_statement
    if (node.type === "export_statement") {
      for (const c of node.children) {
        const found = this.findVariableDeclaration(c, name);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Recursively parse route definition objects from an array node.
   */
  private async parseRouteArray(
    arrayNode: any,
    importMap: Map<string, string>,
    contextDir: string,
    parentPath: string
  ): Promise<void> {
    for (const child of arrayNode.children) {
      if (child.type === "object") {
        await this.parseRouteObject(child, importMap, contextDir, parentPath);
      } else if (child.type === "spread_element") {
        // ...importedRoutes  → resolve from import map
        const identifier = child.children?.find(
          (c: any) => c.type === "identifier"
        );
        if (identifier) {
          const source = importMap.get(identifier.text);
          if (source) {
            await this.parseSpreadRouteModule(source, contextDir, parentPath);
          }
        }
      }
    }
  }

  private async parseRouteObject(
    objNode: any,
    importMap: Map<string, string>,
    contextDir: string,
    parentPath: string
  ): Promise<void> {
    let routePath: string | undefined;
    let routeName: string | undefined;
    let componentSource: string | undefined;
    let childrenNode: any | undefined;

    for (const child of objNode.children) {
      if (child.type !== "pair") continue;

      const keyNode = child.children?.[0];
      const key = keyNode?.text?.replace(/['"]/g, "");
      if (!key) continue;

      // Find value node (skip key and colon)
      const valueNode = child.children.find(
        (_c: any, i: number) => i > 0 && _c.type !== ":" && _c.text !== ":"
      );

      if (key === "path" && valueNode) {
        routePath = valueNode.text?.replace(/['"]/g, "");
      } else if (key === "name" && valueNode) {
        routeName = valueNode.text?.replace(/['"]/g, "");
      } else if (key === "component" && valueNode) {
        componentSource = this.extractComponentSource(valueNode, importMap);
      } else if (key === "children" && valueNode?.type === "array") {
        childrenNode = valueNode;
      }
    }

    const fullPath = this.joinRoutePaths(parentPath, routePath || "");

    if (componentSource) {
      const resolved = await this.graph.resolvePath(contextDir, componentSource);
      const rd: RouteDefinition = {
        path: fullPath,
        name: routeName,
        componentSource,
        componentResolved: resolved || undefined,
      };
      this.routes.push(rd);
    }

    if (childrenNode) {
      await this.parseRouteArray(childrenNode, importMap, contextDir, fullPath);
    }
  }

  private extractComponentSource(
    valueNode: any,
    importMap: Map<string, string>
  ): string | undefined {
    // Case 1: identifier reference → lookup import map
    if (valueNode.type === "identifier") {
      return importMap.get(valueNode.text);
    }

    // Case 2: () => import('...') — arrow function with dynamic import
    if (valueNode.type === "arrow_function") {
      return this.extractDynamicImportPath(valueNode);
    }

    // Case 3: function() { return import('...') }
    if (valueNode.type === "function_expression" || valueNode.type === "function") {
      return this.extractDynamicImportPath(valueNode);
    }

    return undefined;
  }

  private extractDynamicImportPath(node: any): string | undefined {
    // Recursively find `import(...)` call
    if (node.type === "call_expression") {
      const func = node.children?.[0];
      if (func?.type === "import") {
        const args = node.children?.find((c: any) => c.type === "arguments");
        if (args) {
          const strArg = args.children?.find((c: any) => c.type === "string" || c.type === "template_string");
          if (strArg) {
            return strArg.text?.replace(/['"`]/g, "");
          }
        }
      }
    }

    for (const child of node.children || []) {
      const found = this.extractDynamicImportPath(child);
      if (found) return found;
    }
    return undefined;
  }

  private async parseSpreadRouteModule(
    source: string,
    contextDir: string,
    parentPath: string
  ): Promise<void> {
    const resolved = await this.graph.resolvePath(contextDir, source);
    if (!resolved) return;

    let content: string;
    try {
      content = await fs.promises.readFile(resolved, "utf-8");
    } catch {
      return;
    }

    const tsParser = TreeSitterParser.getInstance();
    const langId = tsParser.getLangId(resolved) || "javascript";
    const parseLang = langId === "typescriptreact" ? "typescriptreact" : langId;
    const tree = await tsParser.parseWithCache(parseLang, content);
    if (!tree) return;

    const root = tree.rootNode;
    const importMap = this.buildImportMap(root);
    const subContextDir = path.dirname(resolved);

    // Look for `export default [...]`
    for (const child of root.children) {
      if (child.type === "export_statement") {
        for (const c of child.children) {
          if (c.type === "array") {
            await this.parseRouteArray(c, importMap, subContextDir, parentPath);
            return;
          }
        }
      }
    }

    // Also try `const routes = [...]` + `export default routes` or just bare `[...]`
    for (const child of root.children) {
      const arr = this.findVariableDeclaration(child, "routes");
      if (arr?.type === "array") {
        await this.parseRouteArray(arr, importMap, subContextDir, parentPath);
        return;
      }
    }
  }

  private joinRoutePaths(parent: string, child: string): string {
    if (!child) return parent;
    if (child.startsWith("/")) return child;
    if (!parent) return `/${child}`;
    const p = parent.endsWith("/") ? parent.slice(0, -1) : parent;
    return `${p}/${child}`;
  }

  private rebuildComponentToRoutes(): void {
    this.componentToRoutes.clear();
    for (const rd of this.routes) {
      if (!rd.componentResolved) continue;
      let list = this.componentToRoutes.get(rd.componentResolved);
      if (!list) {
        list = [];
        this.componentToRoutes.set(rd.componentResolved, list);
      }
      list.push(rd);
    }
  }

  // ─── Navigation Call Scanning ────────────────────────────

  private async scanAllNavigationCalls(): Promise<void> {
    const entryConfig =
      vscode.workspace
        .getConfiguration("dependencyDependent")
        .get<string[]>("entryPoints") || [];
    const excludesConfig =
      vscode.workspace
        .getConfiguration("dependencyDependent")
        .get<string[]>("excludes") || [];

    const patterns = entryConfig.length
      ? entryConfig
      : ["src/**/*.{js,ts,jsx,tsx,vue}"];
    const ignore = excludesConfig.map((e) => `**/${e}/**`);

    const globPromises = patterns.map((p) =>
      glob(p, { cwd: this.workspaceRoot, absolute: true, ignore })
    );
    const allFiles = [...new Set((await Promise.all(globPromises)).flat())];

    const CONCURRENCY = 10;
    for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
      const batch = allFiles.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((f) => this.rescanFile(f)));
    }
  }

  /**
   * Walk an AST looking for `this.$router.push(...)` and `.replace(...)`.
   */
  private async extractNavigationCalls(
    filePath: string,
    content: string
  ): Promise<NavigationCall[]> {
    const tsParser = TreeSitterParser.getInstance();
    const langId = tsParser.getLangId(filePath);
    if (!langId) return [];

    let scriptContent = content;
    let parseLang = langId;
    let lineOffset = 0;

    if (langId === "vue") {
      const info = this.extractVueScriptInfo(content);
      if (!info) return [];
      scriptContent = info.scriptContent;
      lineOffset = info.scriptLineOffset;
      parseLang = "typescript";
    }

    const tree = await tsParser.parseWithCache(parseLang, scriptContent);
    if (!tree) return [];

    const calls: NavigationCall[] = [];
    this.walkForNavCalls(tree.rootNode, filePath, lineOffset, calls);
    return calls;
  }

  private walkForNavCalls(
    node: any,
    filePath: string,
    lineOffset: number,
    calls: NavigationCall[]
  ): void {
    if (node.type === "call_expression") {
      const funcNode = node.children?.[0];
      if (funcNode?.type === "member_expression") {
        const property = funcNode.children?.find(
          (c: any) => c.type === "property_identifier"
        );
        const obj = funcNode.children?.find(
          (c: any) => c.type === "member_expression"
        );

        if (
          property &&
          (property.text === "push" || property.text === "replace") &&
          obj
        ) {
          // Check obj is `this.$router`
          const objProp = obj.children?.find(
            (c: any) => c.type === "property_identifier"
          );
          const objObj = obj.children?.find(
            (c: any) => c.type === "this"
          );

          if (objObj && objProp?.text === "$router") {
            const method = property.text as "push" | "replace";
            const argsNode = node.children?.find(
              (c: any) => c.type === "arguments"
            );
            if (argsNode) {
              const firstArg = argsNode.children?.find(
                (c: any) => c.type !== "(" && c.type !== ")" && c.type !== ","
              );
              if (firstArg) {
                const navCall = this.parseNavigationArgument(
                  firstArg,
                  filePath,
                  method,
                  node.startPosition.row + lineOffset,
                  this.buildNavigationSelection(node, lineOffset)
                );
                if (navCall) calls.push(navCall);
              }
            }
          }
        }
      }
    }

    for (const child of node.children || []) {
      this.walkForNavCalls(child, filePath, lineOffset, calls);
    }
  }

  private parseNavigationArgument(
    argNode: any,
    filePath: string,
    method: "push" | "replace",
    line: number,
    selection: NavigationCall["selection"]
  ): NavigationCall | null {
    // String argument: this.$router.push('/user/profile')
    if (argNode.type === "string" || argNode.type === "template_string") {
      const value = argNode.text?.replace(/['"`]/g, "");
      if (value) {
        return {
          callerFile: filePath,
          method,
          targetType: "path",
          targetValue: value,
          line,
          selection,
        };
      }
    }

    // Object argument: this.$router.push({ name: 'xxx' }) or { path: '/xxx' })
    if (argNode.type === "object") {
      for (const child of argNode.children) {
        if (child.type !== "pair") continue;

        const keyNode = child.children?.[0];
        const key = keyNode?.text?.replace(/['"]/g, "");

        if (key === "name" || key === "path") {
          const valueNode = child.children?.find(
            (_c: any, i: number) => i > 0 && _c.type !== ":" && _c.text !== ":"
          );
          if (valueNode) {
            const value = valueNode.text?.replace(/['"`]/g, "");
            if (value) {
              return {
                callerFile: filePath,
                method,
                targetType: key as "name" | "path",
                targetValue: value,
                line,
                selection,
              };
            }
          }
        }
      }
    }

    return null;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private removeNavCallsForFile(filePath: string): void {
    const oldCalls = this.navCallsByFile.get(filePath);
    if (!oldCalls) return;

    for (const call of oldCalls) {
      const key =
        call.targetType === "name"
          ? `name:${call.targetValue}`
          : `path:${call.targetValue}`;
      const list = this.navCallsByTarget.get(key);
      if (list) {
        const filtered = list.filter((c) => c.callerFile !== filePath);
        if (filtered.length === 0) {
          this.navCallsByTarget.delete(key);
        } else {
          this.navCallsByTarget.set(key, filtered);
        }
      }
    }
    this.navCallsByFile.delete(filePath);
  }

  private buildNavigationSelection(
    callExpressionNode: any,
    lineOffset: number
  ): NavigationCall["selection"] {
    let selectionNode = callExpressionNode;
    let current = callExpressionNode?.parent;

    while (current) {
      if (
        current.type === "parenthesized_expression" ||
        current.type === "await_expression"
      ) {
        selectionNode = current;
        current = current.parent;
        continue;
      }

      if (
        current.type === "expression_statement" ||
        current.type === "return_statement" ||
        current.type === "variable_declarator"
      ) {
        selectionNode = current;
      }
      break;
    }

    return {
      startLine: selectionNode.startPosition.row + lineOffset,
      startCharacter: selectionNode.startPosition.column,
      endLine: selectionNode.endPosition.row + lineOffset,
      endCharacter: selectionNode.endPosition.column,
    };
  }

  private extractVueScriptInfo(content: string): { scriptContent: string; scriptLineOffset: number } | null {
    const re = /<script(\b[^>]*)?>([^]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    let best: { scriptContent: string; bodyIndex: number } | null = null;

    while ((match = re.exec(content)) !== null) {
      const attrs = match[1] || "";
      const body = match[2];
      const isSetup = /\bsetup\b/.test(attrs);
      // bodyIndex = start of the body inside the full content
      const bodyIndex = match.index + match[0].indexOf(body);
      if (!best || !isSetup) {
        best = { scriptContent: body, bodyIndex };
        if (!isSetup) break;
      }
    }
    if (!best) return null;

    // Count newlines before the script body to get line offset
    const scriptLineOffset = content.substring(0, best.bodyIndex).split("\n").length - 1;
    return { scriptContent: best.scriptContent, scriptLineOffset };
  }
}
