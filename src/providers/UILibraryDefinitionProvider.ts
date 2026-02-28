import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "module";

/**
 * UI Library path resolution strategy configuration
 * Each library defines its prefix and the source file template
 */
interface LibraryConfig {
  prefix: string;
  sourceTemplate: string;
  // Fallback templates to try if primary doesn't exist
  fallbackTemplates?: string[];
}

const LIBRARY_MAP: Record<string, LibraryConfig> = {
  "element-ui": {
    prefix: "el-",
    sourceTemplate: "packages/${kebabCaseName}/src/main.vue",
    fallbackTemplates: [
      "packages/${kebabCaseName}/index.js",
      "lib/${kebabCaseName}.js"
    ]
  },
  "unicorn-icbc-ui": {
    prefix: "un-",
    sourceTemplate: "packages/${kebabCaseName}/src/main.vue",
    fallbackTemplates: [
      "packages/${kebabCaseName}/index.js",
      "lib/${kebabCaseName}.js"
    ]
  },
  "ant-design-vue": {
    prefix: "a-",
    sourceTemplate: "components/${kebabCaseName}/index.jsx",
    fallbackTemplates: [
      "components/${kebabCaseName}/index.tsx",
      "components/${kebabCaseName}/index.vue",
      "es/${kebabCaseName}/index.js"
    ]
  },
  "vant": {
    prefix: "van-",
    sourceTemplate: "src/${kebabCaseName}/index.vue",
    fallbackTemplates: [
      "src/${kebabCaseName}/index.tsx",
      "es/${kebabCaseName}/index.mjs"
    ]
  }
};

/**
 * UI Library Definition Provider
 * Enables Ctrl+Click navigation for UI component tags to their source code in node_modules
 */
export class UILibraryDefinitionProvider implements vscode.DefinitionProvider {

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | null> {
    // Get the word (tag name) at cursor
    const wordRange = document.getWordRangeAtPosition(position, /[\w-]+/);
    if (!wordRange) return null;

    if (token.isCancellationRequested) return null;

    const tagName = document.getText(wordRange).toLowerCase();

    // Try to resolve using our strategy map
    const resolvedPath = await this.resolveComponentPath(tagName, document.uri.fsPath);

    if (resolvedPath) {
      return new vscode.Location(
        vscode.Uri.file(resolvedPath),
        new vscode.Position(0, 0)
      );
    }

    return null;
  }

  /**
   * Resolve component source path using Node.js module resolution
   * This handles pnpm, yarn workspaces, and monorepos correctly
   */
  private async resolveComponentPath(tagName: string, currentFilePath: string): Promise<string | null> {
    // Find matching library by prefix
    const libEntry = Object.entries(LIBRARY_MAP).find(([_, config]) =>
      tagName.startsWith(config.prefix)
    );

    if (!libEntry) return null;

    const [libName, config] = libEntry;
    
    // Extract component name: el-button -> button
    const rawName = tagName.slice(config.prefix.length);
    
    // Ensure kebab-case (handle edge cases like ElButton -> el-button)
    const kebabName = rawName.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");

    try {
      // Use Node.js resolution to find the real package path
      // This penetrates pnpm symlinks and finds the actual physical location
      const require = createRequire(currentFilePath);
      const pkgJsonPath = require.resolve(`${libName}/package.json`);
      const pkgRoot = path.dirname(pkgJsonPath);

      // Try primary template first
      const templates = [config.sourceTemplate, ...(config.fallbackTemplates || [])];
      
      for (const template of templates) {
        const relativePath = template.replace(/\$\{kebabCaseName\}/g, kebabName);
        const targetPath = path.join(pkgRoot, relativePath);

        try {
          await fs.promises.access(targetPath);
          return targetPath;
        } catch {
          // Template path doesn't exist, try next
        }
      }

      // If no template matched, return null (component might not have source)
      return null;

    } catch (error) {
      // Library not installed or resolution failed
      return null;
    }
  }
}
