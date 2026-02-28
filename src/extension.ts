import * as path from "path";
import * as vscode from "vscode";
import { DepService } from "./DepService";
import configWebpack from "./commands/configWebpack";
import { getLoading, getLocked, setLoading, setLocked } from "./core/context";
import { debounce } from "./core/debounce";
import { computeFuncEnhance } from "./core/funcEnhance";
import { reindentText } from "./core/indent";
import { setContext } from "./share";
import DepExplorerView from "./views/DepExplorerView";
import { TreeSitterParser } from "./core/TreeSitterParser";
import { VueTemplateCompletionProvider } from "./providers/VueTemplateCompletionProvider";
import { VueRangeFormattingProvider } from "./providers/VueRangeFormattingProvider";
import { VueComponentPropsCompletionProvider } from "./providers/VueComponentPropsCompletionProvider";
import { VueComponentTagCompletionProvider } from "./providers/VueComponentTagCompletionProvider";

import { WebpackDefinitionProvider } from "./providers/WebpackDefinitionProvider";
import { VueOptionsDefinitionProvider } from "./providers/VueOptionsDefinitionProvider";
import { VueOptionsCompletionProvider } from "./providers/VueOptionsCompletionProvider";
import { UILibraryDefinitionProvider } from "./providers/UILibraryDefinitionProvider";
import { VuePrototypeScanner } from "./core/VuePrototypeScanner";
import { VueTimelineProvider } from "./views/VueTimelineProvider";

export const log = vscode.window.createOutputChannel("Dependency & Dependent");

// Block select: close→open bracket lookup (< > excluded: they're comparison/generic operators in JS/TS)
const BS_CLOSE_OPEN: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
// Block select: open→close bracket lookup
const BS_OPEN_CLOSE: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

// Stored for deactivate() to cancel
let _debouncedRefresh: ReturnType<typeof debounce> | undefined;

export function activate(context: vscode.ExtensionContext) {
  log.appendLine("Extension activating...");
  setContext(context);

  // Initialize TreeSitterParser with correct extension path
  const wasmPath = path.join(context.extensionPath, 'src', 'grammars');
  const tsParser = TreeSitterParser.getInstance(wasmPath);
  // Pre-initialize wasm to avoid first-parse delay
  tsParser.init().catch(e => log.appendLine(`TreeSitter pre-init failed: ${e.message}`));

  new DepExplorerView(context);
  const vueTimelineProvider = new VueTimelineProvider();
  const vueTimelineView = vscode.window.createTreeView('dependency-dependent-VueTimelineView', {
      treeDataProvider: vueTimelineProvider
  });
  vueTimelineProvider.treeView = vueTimelineView;
  context.subscriptions.push(vueTimelineView);
  
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
  const sharedPrototypeScanner = new VuePrototypeScanner();
  const vueOptionsProvider = new VueOptionsDefinitionProvider(sharedPrototypeScanner);
  const vueSelector = [{ scheme: "file", pattern: "**/*.vue" }];
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(vueSelector, vueOptionsProvider)
  );

  // Register Definition Provider for UI Library components (Element UI, Ant Design Vue, etc.)
  const uiLibProvider = new UILibraryDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(vueSelector, uiLibProvider)
  );

  // Register Completion Provider for Vue Options API (this.xxx + this.$xxx)
  const vueCompletionProvider = new VueOptionsCompletionProvider(sharedPrototypeScanner);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      vueSelector,
      vueCompletionProvider,
      '.', '$'  // trigger on dot and dollar sign
    )
  );

  // Invalidate $xxx cache when root package.json changes (plugin deps may have changed)
  // Use single-level glob to avoid firing on every node_modules/**/ package.json
  const invalidateDebounced = debounce(() => vueCompletionProvider.invalidatePrototypeCache(), 1000);
  const pkgWatcher = vscode.workspace.createFileSystemWatcher('*/package.json', false, false, false);
  pkgWatcher.onDidChange(() => invalidateDebounced());
  pkgWatcher.onDidCreate(() => invalidateDebounced());
  pkgWatcher.onDidDelete(() => invalidateDebounced());
  context.subscriptions.push(pkgWatcher);

  // Register Completion Provider for Vue Template (Mustache, @event, :bind)
  const vueTemplateCompletionProvider = new VueTemplateCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      vueSelector,
      vueTemplateCompletionProvider,
      '{', '"', "'"  // trigger on {{ and attribute value quotes
    )
  );

  // Sub-component Props completion (space trigger inside open tags)
  const vuePropsProvider = new VueComponentPropsCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(vueSelector, vuePropsProvider, ' ')
  );

  // Auto-import component (< trigger in template)
  const vueTagProvider = new VueComponentTagCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(vueSelector, vueTagProvider, '<')
  );

  // Register Formatting Providers for Vue files (Format Selection and Format Document)
  const vueRangeFormattingProvider = new VueRangeFormattingProvider();
  context.subscriptions.push(
    vueRangeFormattingProvider, // dispose() cleans up the internal content provider
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      vueSelector,
      vueRangeFormattingProvider
    ),
    vscode.languages.registerDocumentFormattingEditProvider(
      vueSelector,
      vueRangeFormattingProvider
    )
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
        // Fix: when cursor (no selection) is ON a close bracket, start one position to the
        // left so the close bracket at L is treated as the right boundary of the block,
        // not as a nested bracket to skip over.
        const iStart = (L === R && L > 0 && BS_CLOSE_OPEN[text[L]]) ? L - 1 : L;
        for (let i = iStart; i >= 0; i--) {
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

      // --- 2. Quote scan (state-machine forward pass, O(n), comment-aware) ---
      // States: code → string / line-comment / block-comment, with proper transitions.
      // Quotes inside comments are ignored; \ skips the next char inside strings.
      let qStart = -1, qEnd = -1;
      {
        let state: 'code' | 'str' | 'line_cmt' | 'block_cmt' = 'code';
        let strChar = '', strOpen = -1;
        let lastStrChar = '', lastStrOpen = -1;

        for (let i = 0; i <= L; i++) {
          const c = text[i];
          switch (state) {
            case 'code':
              if      (c === '/' && text[i + 1] === '/') { state = 'line_cmt';  i++; }
              else if (c === '/' && text[i + 1] === '*') { state = 'block_cmt'; i++; }
              else if (c === '"' || c === "'" || c === '`') {
                state = 'str'; strChar = c; strOpen = i;
              }
              break;
            case 'str':
              if      (c === '\\')    { i++; }              // skip escaped char
              else if (c === strChar) {
                lastStrChar = strChar; lastStrOpen = strOpen;
                state = 'code'; strChar = ''; strOpen = -1;
              }
              break;
            case 'line_cmt':  if (c === '\n') state = 'code'; break;
            case 'block_cmt': if (c === '*' && text[i + 1] === '/') { state = 'code'; i++; } break;
          }
        }

        // Resolve opening/closing positions from state after scan
        let oPos = -1, cPos = -1, qChar = '';
        if (state === 'str') {
          // Cursor is inside (or on the opening quote of) the string
          oPos = strOpen; qChar = strChar;
        } else if (lastStrOpen !== -1 && L < len && text[L] === lastStrChar && (L === 0 || text[L - 1] !== '\\')) {
          // Cursor is ON the closing quote of the most recently closed string
          oPos = lastStrOpen; cPos = L; qChar = lastStrChar;
        }

        if (oPos !== -1) {
          if (cPos === -1) {
            // Find closing quote from oPos+1 (j ≥ 1, so text[j-1] is always in-bounds)
            for (let j = oPos + 1; j < len; j++) {
              if (text[j] === qChar && text[j - 1] !== '\\') { cPos = j; break; }
            }
          }
          if (cPos !== -1 && cPos >= R) { qStart = oPos; qEnd = cPos + 1; }
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
  const debounceDelay = config.get<number>("debounceDelay") || 0;

  // Debounced refresh to prevent rapid updates when switching tabs quickly
  const debouncedRefresh = debounce(() => {
    const locked = getLocked();
    if (locked === true) {
      return;
    }

    DepExplorerView.singleton.refresh();
  }, debounceDelay);
  _debouncedRefresh = debouncedRefresh;

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(debouncedRefresh)
  );

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

  context.subscriptions.push(
      vscode.commands.registerCommand(
          "dependency-dependent.vueTimeline.jumpToLocation",
          (item) => {
              if (item) {
                  vueTimelineProvider.jumpToLocation(item);
              }
          }
      )
  );

  // Track Variable Lifecycle: right-click on this.xxx in a .vue file
  context.subscriptions.push(
      vscode.commands.registerCommand(
          "dependency-dependent.vueTimeline.trackVariable",
          async () => {
              const editor = vscode.window.activeTextEditor;
              if (!editor || editor.document.languageId !== 'vue') return;

              const document = editor.document;
              const position = editor.selection.active;
              const wordRange = document.getWordRangeAtPosition(position, /[$\w]+/);
              if (!wordRange) return;

              let variableName = document.getText(wordRange);

              // Check if preceded by "this." — allow clicking on either "this" or the property
              const lineText = document.lineAt(position.line).text;
              const wordStart = wordRange.start.character;

              if (variableName === 'this') {
                  // User clicked on "this" — grab the property after the dot
                  const afterThis = lineText.substring(wordStart + 4); // skip "this"
                  const propMatch = afterThis.match(/^\.(\w+)/);
                  if (propMatch) {
                      variableName = propMatch[1];
                  } else {
                      return;
                  }
              } else if (wordStart >= 5 && lineText.substring(wordStart - 5, wordStart) === 'this.') {
                  // Already have the property name, preceded by "this."
              } else {
                  // Not a this.xxx pattern — still allow tracking by property name
              }

              // Skip $-prefixed properties
              if (variableName.startsWith('$')) return;

              await vueTimelineProvider.enterTrackingMode(variableName, document);
              // Reveal the timeline view
              vueTimelineView.reveal(undefined as any, { focus: true }).catch(() => {
                  // View may not support reveal without an element, just focus
                  vscode.commands.executeCommand('dependency-dependent-VueTimelineView.focus');
              });
          }
      )
  );

  // Exit tracking mode
  context.subscriptions.push(
      vscode.commands.registerCommand(
          "dependency-dependent.vueTimeline.exitTrackingMode",
          () => {
              vueTimelineProvider.exitTrackingMode();
          }
      )
  );

  // --- Func Enhance (Alt+Enter) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.funcEnhance",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const enabled = vscode.workspace
          .getConfiguration("dependencyDependent")
          .get<boolean>("funcEnhance", true);
        if (!enabled) return;

        const doc = editor.document;
        const pos = editor.selection.active;
        const lines = doc.getText().split('\n');
        const insertSpaces = editor.options.insertSpaces as boolean;
        const tabSizeNum = editor.options.tabSize as number;
        const tabSize = insertSpaces ? ' '.repeat(tabSizeNum) : '\t';

        const result = computeFuncEnhance(lines, pos.line, pos.character, tabSize);
        if (!result) return;

        if (result.actionType === 'insert') {
          const lineEnd = new vscode.Position(pos.line, doc.lineAt(pos.line).text.length);
          await editor.edit(eb => eb.insert(lineEnd, result.insertText));
          const newPos = new vscode.Position(result.cursorLine, result.cursorChar);
          editor.selection = new vscode.Selection(newPos, newPos);
        } else {
          // snippet: replace entire line
          const lineRange = doc.lineAt(pos.line).range;
          await editor.edit(eb => eb.replace(lineRange, result.insertText));
          const newPos = new vscode.Position(result.cursorLine, result.cursorChar);
          editor.selection = new vscode.Selection(newPos, newPos);
        }
      }
    )
  );

  // --- Paste and Indent ---
  let pasteSelectAfter = vscode.workspace
    .getConfiguration("dependencyDependent")
    .get<boolean>("pasteAndIndent.selectAfter", false);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("dependencyDependent.pasteAndIndent")) {
        pasteSelectAfter = vscode.workspace
          .getConfiguration("dependencyDependent")
          .get<boolean>("pasteAndIndent.selectAfter", false);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.pasteAndIndent",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const clipboardText = await vscode.env.clipboard.readText();
        if (!clipboardText) return;

        const lines = clipboardText.split('\n');

        // Single-line paste: just insert directly
        if (lines.length <= 1) {
          await editor.edit(editBuilder => {
            for (const sel of editor.selections) {
              if (sel.isEmpty) {
                editBuilder.insert(sel.start, clipboardText);
              } else {
                editBuilder.replace(sel, clipboardText);
              }
            }
          });
          return;
        }

        const insertSpaces = editor.options.insertSpaces as boolean;
        const tabSize = editor.options.tabSize as number;

        await editor.edit(editBuilder => {
          for (const sel of editor.selections) {
            const start = sel.start;
            const startLineText = editor.document.getText(
              new vscode.Range(start.line, 0, start.line, start.character)
            );
            const firstNonWhitespace = startLineText.search(/\S/);
            const offset = firstNonWhitespace > -1 ? firstNonWhitespace : start.character;

            const result = reindentText(clipboardText, offset, { insertSpaces, tabSize });

            if (sel.isEmpty) {
              editBuilder.insert(start, result);
            } else {
              editBuilder.replace(sel, result);
            }
          }
        });

        // Handle selectAfter
        if (pasteSelectAfter && lines.length > 1) {
          const newSelections: vscode.Selection[] = [];
          for (const sel of editor.selections) {
            const startLine = sel.start.line;
            const endLine = sel.end.line;
            const lastLineLength = editor.document.lineAt(endLine).text.length;
            newSelections.push(new vscode.Selection(startLine + 1, 0, endLine, lastLineLength));
          }
          editor.selections = newSelections;
        }
      }
    )
  );
}

export function deactivate() {
  _debouncedRefresh?.cancel();
  DepService.singleton.dispose();
  TreeSitterParser.getInstance().dispose();
  DepExplorerView.singleton?.dispose();
}
