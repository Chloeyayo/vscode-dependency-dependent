import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Describes a Vue instance `$xxx` property available via `this.$xxx`.
 */
export interface VueDollarProperty {
  name: string; // e.g. "$router"
  detail: string; // e.g. "(vue-router)" or "(Vue built-in)"
  documentation: string; // human-readable description
  kind: vscode.CompletionItemKind;
  isMethod: boolean; // whether to auto-append ()
}

// ── A: Vue 2 built-in instance properties ──────────────────────────
const VUE2_BUILTINS: VueDollarProperty[] = [
  // Reactive data
  { name: "$data", detail: "(Vue built-in)", documentation: "The data object that the Vue instance is observing.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$props", detail: "(Vue built-in)", documentation: "An object representing the current props a component has received.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$options", detail: "(Vue built-in)", documentation: "The instantiation options used for the current Vue instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$el", detail: "(Vue built-in)", documentation: "The root DOM element that the Vue instance is managing.", kind: vscode.CompletionItemKind.Field, isMethod: false },

  // Refs & DOM
  { name: "$refs", detail: "(Vue built-in)", documentation: "An object of DOM elements and component instances registered with `ref` attributes.", kind: vscode.CompletionItemKind.Field, isMethod: false },

  // Hierarchy
  { name: "$parent", detail: "(Vue built-in)", documentation: "The parent instance, if the current instance has one.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$root", detail: "(Vue built-in)", documentation: "The root Vue instance of the current component tree.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$children", detail: "(Vue built-in)", documentation: "The direct child components of the current instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },

  // Slots
  { name: "$slots", detail: "(Vue built-in)", documentation: "Used to programmatically access content distributed by slots.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$scopedSlots", detail: "(Vue built-in)", documentation: "Used to programmatically access scoped slots.", kind: vscode.CompletionItemKind.Field, isMethod: false },

  // Attributes & Listeners (Vue 2.4+)
  { name: "$attrs", detail: "(Vue built-in)", documentation: "Contains parent-scope attribute bindings not recognized as props.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  { name: "$listeners", detail: "(Vue built-in)", documentation: "Contains parent-scope v-on event listeners.", kind: vscode.CompletionItemKind.Field, isMethod: false },

  // Methods
  { name: "$emit", detail: "(Vue built-in)", documentation: "Trigger an event on the current instance.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$on", detail: "(Vue built-in)", documentation: "Listen for a custom event on the current instance.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$off", detail: "(Vue built-in)", documentation: "Remove custom event listener(s).", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$once", detail: "(Vue built-in)", documentation: "Listen for a custom event, but only once.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$nextTick", detail: "(Vue built-in)", documentation: "Defer the callback to be executed after the next DOM update cycle.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$set", detail: "(Vue built-in)", documentation: "Set a property on a reactive object, ensuring the new property is also reactive.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$delete", detail: "(Vue built-in)", documentation: "Delete a property on an object, triggering view updates.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$watch", detail: "(Vue built-in)", documentation: "Watch an expression or a computed function on the Vue instance for changes.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$forceUpdate", detail: "(Vue built-in)", documentation: "Force the Vue instance to re-render.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$destroy", detail: "(Vue built-in)", documentation: "Completely destroy the Vue instance.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$mount", detail: "(Vue built-in)", documentation: "Manually mount an unmounted Vue instance.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  { name: "$createElement", detail: "(Vue built-in)", documentation: "Create a VNode. Alias of the render function's argument.", kind: vscode.CompletionItemKind.Method, isMethod: true },
];

// ── B: Known plugins → $xxx mapping ────────────────────────────────
const PLUGIN_MAP: Record<string, VueDollarProperty[]> = {
  "vue-router": [
    { name: "$router", detail: "(vue-router)", documentation: "The router instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },
    { name: "$route", detail: "(vue-router)", documentation: "The current active route object (reactive).", kind: vscode.CompletionItemKind.Field, isMethod: false },
  ],
  "vuex": [
    { name: "$store", detail: "(vuex)", documentation: "The Vuex store instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  ],
  "vue-i18n": [
    { name: "$t", detail: "(vue-i18n)", documentation: "Translate a locale message.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$tc", detail: "(vue-i18n)", documentation: "Translate a locale message with pluralization.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$te", detail: "(vue-i18n)", documentation: "Check if a key exists in locale messages.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$d", detail: "(vue-i18n)", documentation: "Localize a datetime.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$n", detail: "(vue-i18n)", documentation: "Localize a number.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$i18n", detail: "(vue-i18n)", documentation: "The VueI18n instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  ],
  "axios": [
    { name: "$http", detail: "(axios)", documentation: "Axios HTTP client instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  ],
  "vue-axios": [
    { name: "$http", detail: "(axios)", documentation: "Axios HTTP client instance.", kind: vscode.CompletionItemKind.Field, isMethod: false },
  ],
  "element-ui": [
    { name: "$message", detail: "(element-ui)", documentation: "Element UI Message service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$msgbox", detail: "(element-ui)", documentation: "Element UI MessageBox service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$alert", detail: "(element-ui)", documentation: "Element UI alert dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$confirm", detail: "(element-ui)", documentation: "Element UI confirm dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$prompt", detail: "(element-ui)", documentation: "Element UI prompt dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$notify", detail: "(element-ui)", documentation: "Element UI Notification service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$loading", detail: "(element-ui)", documentation: "Element UI Loading service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  ],
  "unicorn-icbc-ui": [
    { name: "$message", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI Message service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$msgbox", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI MessageBox service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$alert", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI alert dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$confirm", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI confirm dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$prompt", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI prompt dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$notify", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI Notification service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$loading", detail: "(unicorn-icbc-ui)", documentation: "Unicorn ICBC UI Loading service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  ],
  "ant-design-vue": [
    { name: "$message", detail: "(ant-design-vue)", documentation: "Ant Design Vue Message service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$notification", detail: "(ant-design-vue)", documentation: "Ant Design Vue Notification service.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$info", detail: "(ant-design-vue)", documentation: "Ant Design Vue info dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$success", detail: "(ant-design-vue)", documentation: "Ant Design Vue success dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$error", detail: "(ant-design-vue)", documentation: "Ant Design Vue error dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$warning", detail: "(ant-design-vue)", documentation: "Ant Design Vue warning dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
    { name: "$confirm", detail: "(ant-design-vue)", documentation: "Ant Design Vue confirm dialog.", kind: vscode.CompletionItemKind.Method, isMethod: true },
  ],
};

// Regex to match Vue.prototype.$xxx = ... assignments
const VUE_PROTOTYPE_RE = /Vue\.prototype\.(\$\w+)\s*=/g;

/**
 * Scans the workspace for Vue `$xxx` instance properties.
 * Sources: Vue 2 builtins, package.json plugin detection, entry file scanning, user config.
 * Results are cached at workspace level and only re-scanned when needed.
 */
export class VuePrototypeScanner {
  // Workspace-level cache: maps workspace folder URI to cached properties
  private workspaceCache = new Map<string, {
    timestamp: number;
    properties: VueDollarProperty[];
  }>();

  // Cache TTL: 60 seconds (package.json / entry files rarely change mid-session)
  private static readonly CACHE_TTL = 60_000;

  /**
   * Get all `$xxx` properties available for the given document.
   * Uses workspace-level caching for performance.
   */
  async getProperties(document: vscode.TextDocument): Promise<VueDollarProperty[]> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cacheKey = workspaceFolder?.uri.toString() ?? '__global__';

    // Check cache
    const cached = this.workspaceCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < VuePrototypeScanner.CACHE_TTL) {
      return cached.properties;
    }

    // Build the full list
    const results = new Map<string, VueDollarProperty>();

    // A: Built-ins (always available)
    for (const prop of VUE2_BUILTINS) {
      results.set(prop.name, prop);
    }

    // B: Plugin detection from package.json
    if (workspaceFolder) {
      const pluginProps = await this.detectPlugins(workspaceFolder.uri.fsPath);
      for (const prop of pluginProps) {
        if (!results.has(prop.name)) {
          results.set(prop.name, prop);
        }
      }

      // Scan entry files for Vue.prototype.$xxx
      const entryProps = await this.scanEntryFiles(workspaceFolder.uri.fsPath);
      for (const prop of entryProps) {
        if (!results.has(prop.name)) {
          results.set(prop.name, prop);
        }
      }
    }

    // C: User-configured custom properties
    const userProps = this.getUserConfiguredProperties();
    for (const prop of userProps) {
      if (!results.has(prop.name)) {
        results.set(prop.name, prop);
      }
    }

    const properties = Array.from(results.values());
    this.workspaceCache.set(cacheKey, { timestamp: Date.now(), properties });
    return properties;
  }

  /**
   * Invalidate cache (e.g. when package.json changes).
   */
  invalidateCache(): void {
    this.workspaceCache.clear();
  }

  /**
   * Find the definition location of a `$xxx` property.
   * Priority:
   *   1. `Vue.prototype.$xxx = ...` in user entry files (main.js etc.)
   *   2. `Vue.prototype.$xxx = ...` or `prototype.$xxx = ...` in the plugin's own source (node_modules)
   *   3. Plugin import/require in entry files (fallback)
   */
  async findDefinition(
    propertyName: string,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<vscode.Location | null> {
    const workspacePath = workspaceFolder.uri.fsPath;

    const candidates = [
      'main.js', 'main.ts',
      'src/main.js', 'src/main.ts',
      'app/main.js', 'app/main.ts',
    ];

    // 1. Search for Vue.prototype.$xxx = ... in user entry files
    const prototypePattern = new RegExp(
      `Vue\\.prototype\\.\\${propertyName}\\s*=`, 'g'
    );

    for (const candidate of candidates) {
      const filePath = path.join(workspacePath, candidate);
      try {
        await fs.promises.access(filePath);
        const content = await fs.promises.readFile(filePath, 'utf-8');

        const protoMatch = prototypePattern.exec(content);
        if (protoMatch) {
          return this.matchToLocation(filePath, content, protoMatch.index);
        }
      } catch {
        // Ignore file read errors
      }
    }

    // 2. For known plugin properties, search inside the plugin's source in node_modules
    const pluginName = this.getPluginForProperty(propertyName);
    if (pluginName) {
      const pluginLocation = await this.findInPluginSource(pluginName, propertyName, workspacePath);
      if (pluginLocation) return pluginLocation;

      // 3. Fallback: find the plugin import/require in entry files
      const importPattern = new RegExp(
        `(?:import\\s+.*?from\\s+['"]${pluginName}['"]|require\\s*\\(\\s*['"]${pluginName}['"]\\s*\\))`,
        'g'
      );

      for (const candidate of candidates) {
        const filePath = path.join(workspacePath, candidate);
        try {
          await fs.promises.access(filePath);
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const importMatch = importPattern.exec(content);
          if (importMatch) {
            return this.matchToLocation(filePath, content, importMatch.index);
          }
        } catch {
          // Ignore
        }
      }
    }

    return null;
  }

  /**
   * Search inside a plugin's source files in node_modules for `Vue.prototype.$xxx` or `prototype.$xxx`.
   */
  private async findInPluginSource(
    pluginName: string,
    propertyName: string,
    workspacePath: string
  ): Promise<vscode.Location | null> {
    // Known source file paths to scan inside each plugin package
    const PLUGIN_SOURCE_FILES: Record<string, string[]> = {
      "element-ui": ["src/index.js", "lib/element-ui.common.js"],
      "unicorn-icbc-ui": ["src/index.js", "lib/unicorn-icbc-ui.common.js", "lib/index.js"],
      "ant-design-vue": ["lib/index.js", "es/index.js"],
      "vuex": ["src/store.js", "src/index.js", "dist/vuex.esm.js", "dist/vuex.common.js"],
      "vue-router": ["src/install.js", "src/index.js", "dist/vue-router.esm.js"],
      "vue-i18n": ["src/install.js", "src/index.js", "dist/vue-i18n.esm.js"],
      "vue-axios": ["src/index.js", "dist/vue-axios.common.js"],
    };

    try {
      // Resolve the plugin's package.json to find its root directory
      const { createRequire } = require('module');
      const fakeEntryPath = path.join(workspacePath, 'node_modules', '.package-resolve.js');
      const require2 = createRequire(fakeEntryPath);
      const pkgJsonPath = require2.resolve(`${pluginName}/package.json`);
      const pkgRoot = path.dirname(pkgJsonPath);

      // Get source files to scan (use mapped list or fall back to package main)
      const sourceFiles = PLUGIN_SOURCE_FILES[pluginName] || [];

      // Also add the package's "main" field as a candidate
      try {
        const pkgJson = JSON.parse(await fs.promises.readFile(pkgJsonPath, 'utf-8'));
        if (pkgJson.main) sourceFiles.push(pkgJson.main);
        if (pkgJson.module) sourceFiles.push(pkgJson.module);
      } catch { /* ignore */ }

      // Patterns to match: Vue.prototype.$xxx or prototype.$xxx
      const patterns = [
        new RegExp(`Vue\\.prototype\\.\\${propertyName}\\s*=`),
        new RegExp(`prototype\\.\\${propertyName}\\s*=`),
      ];

      for (const relPath of sourceFiles) {
        const filePath = path.join(pkgRoot, relPath);
        try {
          await fs.promises.access(filePath);
          const content = await fs.promises.readFile(filePath, 'utf-8');

          for (const pattern of patterns) {
            const match = pattern.exec(content);
            if (match) {
              return this.matchToLocation(filePath, content, match.index);
            }
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Plugin not installed or resolution failed
    }

    return null;
  }

  /**
   * Convert a match offset to a vscode.Location.
   */
  private matchToLocation(filePath: string, content: string, matchIndex: number): vscode.Location {
    const line = content.substring(0, matchIndex).split('\n').length - 1;
    const col = matchIndex - content.lastIndexOf('\n', matchIndex) - 1;
    const uri = vscode.Uri.file(filePath);
    return new vscode.Location(uri, new vscode.Position(line, col));
  }

  /**
   * Look up which plugin provides a given $xxx property.
   */
  private getPluginForProperty(propertyName: string): string | null {
    for (const [pluginName, props] of Object.entries(PLUGIN_MAP)) {
      if (props.some(p => p.name === propertyName)) {
        return pluginName;
      }
    }
    return null;
  }

  /**
   * B: Detect installed plugins from package.json.
   */
  private async detectPlugins(workspacePath: string): Promise<VueDollarProperty[]> {
    const packageJsonPath = path.join(workspacePath, 'package.json');
    try {
      const content = await fs.promises.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      const results: VueDollarProperty[] = [];
      for (const [pluginName, props] of Object.entries(PLUGIN_MAP)) {
        if (allDeps[pluginName]) {
          results.push(...props);
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Scan entry files (main.js, main.ts, src/main.js, src/main.ts) for
   * `Vue.prototype.$xxx = ...` patterns.
   */
  private async scanEntryFiles(workspacePath: string): Promise<VueDollarProperty[]> {
    const candidates = [
      'main.js', 'main.ts',
      'src/main.js', 'src/main.ts',
      'app/main.js', 'app/main.ts',
    ];

    const results: VueDollarProperty[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const filePath = path.join(workspacePath, candidate);
      try {
        await fs.promises.access(filePath);
        const content = await fs.promises.readFile(filePath, 'utf-8');
        let match: RegExpExecArray | null;

        // Reset regex state
        VUE_PROTOTYPE_RE.lastIndex = 0;
        while ((match = VUE_PROTOTYPE_RE.exec(content)) !== null) {
          const name = match[1]; // e.g. "$api"
          if (!seen.has(name)) {
            seen.add(name);
            results.push({
              name,
              detail: `(Vue.prototype)`,
              documentation: `Custom property from \`${candidate}\`: \`Vue.prototype.${name}\``,
              kind: vscode.CompletionItemKind.Field,
              isMethod: false,
            });
          }
        }
      } catch {
        // Ignore file read errors
      }
    }

    return results;
  }

  /**
   * C: Read user-configured custom $xxx properties from settings.
   */
  private getUserConfiguredProperties(): VueDollarProperty[] {
    const config = vscode.workspace.getConfiguration("dependencyDependent");
    const customProps = config.get<string[]>("vue.customDollarProperties", []);

    return customProps.map(name => {
      const propName = name.startsWith('$') ? name : `$${name}`;
      return {
        name: propName,
        detail: "(custom)",
        documentation: `User-configured property: \`this.${propName}\``,
        kind: vscode.CompletionItemKind.Field,
        isMethod: false,
      };
    });
  }
}
