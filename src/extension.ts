import * as path from "path";
import * as vscode from "vscode";
import { DepService } from "./DepService";
import configWebpack from "./commands/configWebpack";
import { getLoading, getLocked, setLoading, setLocked } from "./core/context";
import { debounce } from "./core/debounce";
import { setContext } from "./share";
import DepExplorerView from "./views/DepExplorerView";
import { TreeSitterParser } from "./core/TreeSitterParser";

import { WebpackDefinitionProvider } from "./providers/WebpackDefinitionProvider";
import { VueOptionsDefinitionProvider } from "./providers/VueOptionsDefinitionProvider";
import { UILibraryDefinitionProvider } from "./providers/UILibraryDefinitionProvider";

export const log = vscode.window.createOutputChannel("Dependency & Dependent");

// Block select: close→open bracket lookup
const BS_CLOSE_OPEN: Record<string, string> = { '}': '{', ']': '[', ')': '(', '>': '<' };
// Block select: open→close bracket lookup
const BS_OPEN_CLOSE: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' };

export function activate(context: vscode.ExtensionContext) {
  log.appendLine("Extension activating...");
  setContext(context);

  // Initialize TreeSitterParser with correct extension path
  const wasmPath = path.join(context.extensionPath, 'src', 'grammars');
  const tsParser = TreeSitterParser.getInstance(wasmPath);
  // Pre-initialize wasm to avoid first-parse delay
  tsParser.init().catch(e => log.appendLine(`TreeSitter pre-init failed: ${e.message}`));

  new DepExplorerView(context);
  
  // Set up file system watcher for incremental dependency graph updates
  DepService.singleton.setupFileWatcher(context);

  // Register Definition Provider for Webpack Alias support
  const webpackProvider = new WebpackDefinitionProvider();
  const selector = [
    { scheme: "file", pattern: "**/*.js" },
    { scheme: "file", pattern: "**/*.ts" },
    { scheme: "file", pattern: "**/*.jsx" },
    { scheme: "file", pattern: "**/*.tsx" },
    { scheme: "file", pattern: "**/*.vue" },
  ];
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, webpackProvider)
  );

  // Register Definition Provider for Vue2 Options API
  const vueOptionsProvider = new VueOptionsDefinitionProvider();
  const vueSelector = [{ scheme: "file", pattern: "**/*.vue" }];
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(vueSelector, vueOptionsProvider)
  );

  // Register Definition Provider for UI Library components (Element UI, Ant Design Vue, etc.)
  const uiLibProvider = new UILibraryDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(vueSelector, uiLibProvider)
  );

  // Block select command: expand selection to enclosing bracket/quote pair
  context.subscriptions.push(
    vscode.commands.registerCommand("dependency-dependent.blockSelect", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const text = doc.getText();
      const len = text.length;
      const sel = editor.selection;

      let L = doc.offsetAt(sel.start);
      let R = doc.offsetAt(sel.end);
      if (L !== R) { L--; R++; }

      // --- 1. Bracket scan (stack-based, handles nesting) ---
      let bStart = -1, bOpen = '';
      {
        const stk: string[] = [];
        for (let i = L; i >= 0; i--) {
          const c = text[i];
          if (BS_CLOSE_OPEN[c]) {
            stk.push(c);
          } else if (BS_OPEN_CLOSE[c]) {
            if (stk.length > 0 && BS_CLOSE_OPEN[stk[stk.length - 1]] === c) {
              stk.pop();
            } else if (stk.length === 0) {
              bStart = i;
              bOpen = c;
              break;
            }
          }
        }
      }

      let bEnd = -1;
      if (bStart !== -1) {
        const bClose = BS_OPEN_CLOSE[bOpen];
        let bal = 0;
        for (let i = bStart + 1; i < len; i++) {
          const c = text[i];
          if (c === bOpen) { bal++; }
          else if (c === bClose) {
            if (bal === 0) { bEnd = i + 1; break; }
            bal--;
          }
        }
      }

      // --- 2. Quote scan (single pass, nearest-first) ---
      let qStart = -1, qEnd = -1;
      for (let i = L; i >= 0; i--) {
        const c = text[i];
        if ((c === '"' || c === "'" || c === '`') && (i === 0 || text[i - 1] !== '\\')) {
          // Scan right for matching quote
          let rp = -1;
          for (let j = R; j < len; j++) {
            if (text[j] === c && text[j - 1] !== '\\') { rp = j + 1; break; }
          }
          if (rp === -1) continue;

          // Validate: inner same-quote count must be even
          let cnt = 0;
          for (let j = i + 1; j < rp - 1; j++) {
            if (text[j] === c && (j === 0 || text[j - 1] !== '\\')) cnt++;
          }
          if (cnt & 1) continue;

          qStart = i;
          qEnd = rp;
          break;
        }
      }

      // --- 3. Pick tightest result ---
      let rStart: number, rEnd: number;
      const hasBracket = bStart !== -1 && bEnd !== -1;
      const hasQuote = qStart !== -1 && qEnd !== -1;

      if (hasBracket && hasQuote) {
        if ((qEnd - qStart) < (bEnd - bStart)) {
          rStart = qStart; rEnd = qEnd;
        } else {
          rStart = bStart; rEnd = bEnd;
        }
      } else if (hasBracket) {
        rStart = bStart; rEnd = bEnd;
      } else if (hasQuote) {
        rStart = qStart; rEnd = qEnd;
      } else {
        return;
      }

      // --- 4. Include trailing comma or semicolon ---
      if (rEnd < len) {
        const trail = text[rEnd];
        if (trail === ',' || trail === ';') rEnd++;
      }

      editor.selection = new vscode.Selection(doc.positionAt(rStart), doc.positionAt(rEnd));
    })
  );

  const config = vscode.workspace.getConfiguration("dependencyDependent");
  const debounceDelay = config.get<number>("debounceDelay") || 300;

  // Debounced refresh to prevent rapid updates when switching tabs quickly
  const debouncedRefresh = debounce(() => {
    const locked = getLocked();
    if (locked === true) {
      return;
    }

    DepExplorerView.singleton.refresh();
  }, debounceDelay);

  vscode.window.onDidChangeActiveTextEditor(debouncedRefresh);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.refresh",
      async () => {
        try {
          if (getLoading() === true) {
            return;
          }

          await setLoading(true);
          DepExplorerView.singleton.setTreeViewMessage("");
          await DepService.singleton.updateActiveWorkspaceDepMap();
          await setLoading(false);
          DepExplorerView.singleton.refresh();
        } catch (error: any) {
          DepExplorerView.singleton.setTreeViewMessage(
            error?.message || "Unknown error"
          );
          throw error;
        } finally {
          await setLoading(false);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.configEntryPoints",
      async () => {
        vscode.commands.executeCommand(
          "workbench.action.openWorkspaceSettings",
          {
            query: "dependencyDependent.entryPoints",
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.configWebpack",
      async () => {
        return configWebpack();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dependency-dependent.lock", async () => {
      return setLocked(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("dependency-dependent.unlock", async () => {
      await setLocked(false);
      DepExplorerView.singleton.refresh();
      return;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.openAndReveal",
      async (filePath: string, referencePath?: string) => {
        const uri = vscode.Uri.file(filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);

          if (referencePath) {
            const fileName = path.basename(referencePath);
            const nameNoExt = fileName.substring(0, fileName.lastIndexOf("."));

            for (let i = 0; i < doc.lineCount; i++) {
              const text = doc.lineAt(i).text;
              if (
                (text.includes("import") || text.includes("require")) &&
                (text.includes(fileName) ||
                  (nameNoExt && text.includes(nameNoExt)))
              ) {
                const range = doc.lineAt(i).range;
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                break;
              }
            }
          }
        } catch (error) {
          vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
        }
      }
    )
  );
}

export function deactivate() {}
