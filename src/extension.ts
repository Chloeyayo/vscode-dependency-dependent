import * as path from "path";
import * as vscode from "vscode";
import { DepService } from "./DepService";
import configWebpack from "./commands/configWebpack";
import jumpToTemplateComponentTag from "./commands/jumpToTemplateComponentTag";
import { getLoading, getLocked, setLoading, setLocked } from "./core/context";
import { debounce } from "./core/debounce";
import { computeFuncEnhance } from "./core/funcEnhance";
import { generateVueOption } from "./core/vueOptionGenerate";
import { reindentText } from "./core/indent";
import { setContext } from "./share";
import DepExplorerView from "./views/DepExplorerView";
import { TreeSitterParser } from "./core/TreeSitterParser";
import { VueTemplateCompletionProvider } from "./providers/VueTemplateCompletionProvider";
import { VueRangeFormattingProvider } from "./providers/VueRangeFormattingProvider";
import { VueComponentPropsCompletionProvider } from "./providers/VueComponentPropsCompletionProvider";
import { VueComponentTagCompletionProvider } from "./providers/VueComponentTagCompletionProvider";
import { VueStyleCompletionProvider } from "./providers/VueStyleCompletionProvider";

import { WebpackDefinitionProvider } from "./providers/WebpackDefinitionProvider";
import { VueOptionsDefinitionProvider } from "./providers/VueOptionsDefinitionProvider";
import { VueOptionsCompletionProvider } from "./providers/VueOptionsCompletionProvider";
import { VueOptionsHoverProvider } from "./providers/VueOptionsHoverProvider";
import { UILibraryDefinitionProvider } from "./providers/UILibraryDefinitionProvider";
import { VuePrototypeScanner } from "./core/VuePrototypeScanner";
import { VueTimelineProvider } from "./views/VueTimelineProvider";
import { log } from "./log";

export { log };

// Block select: close→open bracket lookup (< > excluded: they're comparison/generic operators in JS/TS)
const BS_CLOSE_OPEN: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
// Block select: open→close bracket lookup
const BS_OPEN_CLOSE: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
// Block select: inner-first delimiter → matching closer
const BS_INNER_CLOSERS: Record<string, string> = {
  "'": "'", '"': '"', '`': '`',
  '(': ')', '[': ']', '{': '}'
};

/** Check if char at `pos` is escaped by counting preceding backslashes */
function isEscapedAt(text: string, pos: number): boolean {
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * Forward-scan from an open bracket at `openPos` to find its matching close bracket.
 * Handles nesting, strings (single/double/backtick), line comments, and block comments.
 * Returns the index of the matching close bracket, or -1 if not found.
 */
function findMatchForward(text: string, openPos: number): number {
  const open = text[openPos];
  const close = BS_OPEN_CLOSE[open];
  if (!close) return -1;
  let depth = 0;
  let state: 'code' | 'str' | 'line_cmt' | 'block_cmt' = 'code';
  let strChar = '';
  for (let i = openPos; i < text.length; i++) {
    const c = text[i];
    switch (state) {
      case 'code':
        if (c === '/' && text[i + 1] === '/') { state = 'line_cmt'; i++; }
        else if (c === '/' && text[i + 1] === '*') { state = 'block_cmt'; i++; }
        else if (c === '"' || c === "'" || c === '`') { state = 'str'; strChar = c; }
        else if (c === open) { depth++; }
        else if (c === close) { depth--; if (depth === 0) return i; }
        break;
      case 'str':
        if (c === '\\') { i++; }
        else if (c === strChar) { state = 'code'; }
        break;
      case 'line_cmt':
        if (c === '\n') state = 'code';
        break;
      case 'block_cmt':
        if (c === '*' && text[i + 1] === '/') { state = 'code'; i++; }
        break;
    }
  }
  return -1;
}

// Block select: known HTML void elements (no closing tag)
const BS_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Find the innermost HTML/XML tag pair enclosing the range [L, R].
 * Handles nesting, void elements, self-closing tags, and quoted attributes containing '>'.
 * Returns { start, end } covering from '<' of opener to '>' of closer, or null.
 */
function findEnclosingTag(text: string, L: number, R: number): { start: number; end: number } | null {
  // Regex matches opening/closing tags, correctly handling quoted attribute values
  const tagRe = /<(\/?)([a-zA-Z][\w-:.]*)\b(?:[^>"']*(?:"[^"]*"|'[^']*'))*[^>"']*(\/?)>/g;
  const allTags: { name: string; start: number; end: number; isClose: boolean }[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(text)) !== null) {
    const isClose = m[1] === '/';
    const isSelfClose = m[3] === '/';
    const name = m[2].toLowerCase();
    if (isSelfClose || BS_VOID_ELEMENTS.has(name)) continue;
    allTags.push({ name, start: m.index, end: m.index + m[0].length, isClose });
  }

  // Backward scan: find innermost unmatched opening tag at or before L
  const closeStack: string[] = [];
  let openerIdx = -1;
  for (let i = allTags.length - 1; i >= 0; i--) {
    const t = allTags[i];
    if (t.start > L) continue;
    if (t.isClose) {
      closeStack.push(t.name);
    } else {
      if (closeStack.length > 0 && closeStack[closeStack.length - 1] === t.name) {
        closeStack.pop();
      } else {
        openerIdx = i;
        break;
      }
    }
  }

  if (openerIdx === -1) return null;
  const opener = allTags[openerIdx];

  // Forward scan: find matching closer for the opener
  let depth = 0;
  for (let i = openerIdx + 1; i < allTags.length; i++) {
    const t = allTags[i];
    if (t.name !== opener.name) continue;
    if (t.isClose) {
      if (depth === 0) {
        return t.end >= R ? { start: opener.start, end: t.end } : null;
      }
      depth--;
    } else {
      depth++;
    }
  }

  return null;
}

// Stored for deactivate() to cancel
let _debouncedRefresh: ReturnType<typeof debounce> | undefined;

export function activate(context: vscode.ExtensionContext) {
  log.appendLine("Extension activating...");
  setContext(context);

  // Initialize TreeSitterParser with correct extension path
  // Try src/grammars first (dev mode), fall back to grammars/ (packaged extension)
  const srcGrammars = path.join(context.extensionPath, 'src', 'grammars');
  const rootGrammars = path.join(context.extensionPath, 'grammars');
  const wasmPath = require('fs').existsSync(srcGrammars) ? srcGrammars : rootGrammars;
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
  context.subscriptions.push(vueTimelineProvider); // dispose event listeners
  
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

  // Register Hover Provider for Vue Options API (this.xxx type info)
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(vueSelector, new VueOptionsHoverProvider())
  );

  // Invalidate $xxx cache when root package.json changes (plugin deps may have changed)
  // Use single-level glob to avoid firing on every node_modules/**/ package.json
  const invalidateDebounced = debounce(() => vueCompletionProvider.invalidatePrototypeCache(), 1000);
  const pkgWatchers = new Map<string, vscode.FileSystemWatcher>();
  const registerPkgWatcher = (workspace: vscode.WorkspaceFolder) => {
    const key = workspace.uri.toString();
    if (pkgWatchers.has(key)) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspace, "package.json"),
      false,
      false,
      false
    );
    watcher.onDidChange(() => invalidateDebounced());
    watcher.onDidCreate(() => invalidateDebounced());
    watcher.onDidDelete(() => invalidateDebounced());
    pkgWatchers.set(key, watcher);
    context.subscriptions.push(watcher);
  };

  for (const workspace of vscode.workspace.workspaceFolders || []) {
    registerPkgWatcher(workspace);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const removed of event.removed) {
        const key = removed.uri.toString();
        const watcher = pkgWatchers.get(key);
        if (watcher) {
          watcher.dispose();
          pkgWatchers.delete(key);
        }
      }
      for (const added of event.added) {
        registerPkgWatcher(added);
      }
    })
  );

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
    vueTagProvider,
    vscode.languages.registerCompletionItemProvider(vueSelector, vueTagProvider, '<')
  );

  // CSS/SCSS/Less completion inside <style> blocks
  const vueStyleProvider = new VueStyleCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      vueSelector,
      vueStyleProvider,
      ':', ';', ' ', '{', '.', '#', '-', '!', '@', '/', '(', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    )
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

      const isWordChar = (c: string) => /[a-zA-Z0-9_$]/.test(c);
      const innerFirstChars: string = vscode.workspace
        .getConfiguration('dependencyDependent')
        .get<string>('blockSelect.innerFirstChars', '\'\"(`') ?? '';

      // --- Phase 0: Member declaration / call-expression detection ---
      // When cursor is on a word (no selection), try to select the entire member or call expression.
      if (L === R) {

        // Only fire when cursor is on a word character
        if (L < len && isWordChar(text[L])) {
          // 1. Find word boundaries at cursor
          let wordStart = L;
          while (wordStart > 0 && isWordChar(text[wordStart - 1])) wordStart--;
          let wordEnd = L;
          while (wordEnd < len && isWordChar(text[wordEnd])) wordEnd++;

          // 2. Extend left through '.' + word to build dotted chain (e.g. this.$message)
          let chainStart = wordStart;
          {
            let p = chainStart;
            while (true) {
              if (p > 0 && text[p - 1] === '.') {
                let wStart = p - 2;
                while (wStart >= 0 && isWordChar(text[wStart])) wStart--;
                wStart++;
                if (wStart < p - 1) {
                  chainStart = wStart;
                  p = wStart;
                  continue;
                }
              }
              break;
            }
          }

          // 3. Extend right through '.' + word
          let chainEnd = wordEnd;
          {
            let p = chainEnd;
            while (true) {
              if (p < len && text[p] === '.') {
                let wEnd = p + 1;
                while (wEnd < len && isWordChar(text[wEnd])) wEnd++;
                if (wEnd > p + 1) {
                  chainEnd = wEnd;
                  p = wEnd;
                  continue;
                }
              }
              break;
            }
          }

          // 4. Determine exprStart: scan backward past whitespace for async/await keyword
          let exprStart = chainStart;
          {
            let p = chainStart - 1;
            while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
            // Check for 'async' or 'await' keyword preceding the chain
            for (const kw of ['async', 'await']) {
              const kwStart = p - kw.length + 1;
              if (kwStart >= 0 && text.substring(kwStart, p + 1) === kw) {
                // Ensure it's a whole word (not part of a larger identifier)
                if (kwStart === 0 || !isWordChar(text[kwStart - 1])) {
                  exprStart = kwStart;
                  break;
                }
              }
            }
          }

          // 5. If the word at cursor IS "async"/"await" and the chain is just that keyword,
          //    extend chainEnd forward to the next word/chain
          const cursorWord = text.substring(wordStart, wordEnd);
          if ((cursorWord === 'async' || cursorWord === 'await') && chainStart === wordStart && chainEnd === wordEnd) {
            exprStart = wordStart;
            let p = wordEnd;
            while (p < len && (text[p] === ' ' || text[p] === '\t')) p++;
            if (p < len && isWordChar(text[p])) {
              let nextStart = p;
              while (p < len && isWordChar(text[p])) p++;
              chainEnd = p;
              // Continue extending through dots
              while (p < len && text[p] === '.') {
                let wEnd = p + 1;
                while (wEnd < len && isWordChar(text[wEnd])) wEnd++;
                if (wEnd > p + 1) { chainEnd = wEnd; p = wEnd; } else break;
              }
            }
          }

          // 6. From chainEnd, skip whitespace, check next char
          let p0 = chainEnd;
          while (p0 < len && (text[p0] === ' ' || text[p0] === '\t')) p0++;

          let memberEnd = -1;

          if (p0 < len && text[p0] === ':') {
            // Property pattern: name: value
            let v = p0 + 1;
            while (v < len && (text[v] === ' ' || text[v] === '\t' || text[v] === '\n' || text[v] === '\r')) v++;
            if (v < len) {
              const vc = text[v];
              if (vc === '{' || vc === '[' || vc === '(') {
                const closeIdx = findMatchForward(text, v);
                if (closeIdx !== -1) memberEnd = closeIdx + 1;
              } else if (vc === '"' || vc === "'" || vc === '`') {
                // Find matching quote
                for (let j = v + 1; j < len; j++) {
                  if (text[j] === vc && !isEscapedAt(text, j)) { memberEnd = j + 1; break; }
                }
              } else {
                // Scan to ',' or newline at depth 0
                let depth = 0;
                for (let j = v; j < len; j++) {
                  const jc = text[j];
                  if (jc === '(' || jc === '[' || jc === '{') depth++;
                  else if (jc === ')' || jc === ']' || jc === '}') {
                    if (depth === 0) { memberEnd = j; break; }
                    depth--;
                  } else if (depth === 0 && (jc === ',' || jc === '\n')) {
                    memberEnd = j;
                    break;
                  }
                }
                if (memberEnd === -1) memberEnd = len;
              }
            }
          } else if (p0 < len && text[p0] === '(') {
            // Method/call pattern
            const parenClose = findMatchForward(text, p0);
            if (parenClose !== -1) {
              // Check what follows the closing paren
              let afterParen = parenClose + 1;
              while (afterParen < len && (text[afterParen] === ' ' || text[afterParen] === '\t')) afterParen++;
              if (afterParen < len && text[afterParen] === '{') {
                // Method declaration: name(...) { ... }
                const braceClose = findMatchForward(text, afterParen);
                if (braceClose !== -1) memberEnd = braceClose + 1;
              } else {
                // Call expression: name(...)
                memberEnd = parenClose + 1;
              }
            }
          }

          if (memberEnd !== -1) {
            // 7. Include trailing ',' or ';'
            if (memberEnd < len && (text[memberEnd] === ',' || text[memberEnd] === ';')) memberEnd++;
            editor.selection = new vscode.Selection(doc.positionAt(exprStart), doc.positionAt(memberEnd));
            return;
          }
        }
      }

      // --- Phase 0.5: Expand bracket selection to full member/call ---
      // When the current selection starts at '{' or '(', expand backward to include the member signature or call chain.
      // e.g. `{ ... },` → re-invoke → `cancelEdit(row) { ... },`
      // e.g. `({...})` → re-invoke → `this.$message({...})`
      if (L !== R && (text[L] === '{' || text[L] === '(')) {
        let scanPos = L - 1;
        // Skip whitespace before the bracket
        while (scanPos >= 0 && (text[scanPos] === ' ' || text[scanPos] === '\t')) scanPos--;

        let memberStart = -1;

        // Helper: find chain start and async/await from a position on the last word char
        const findChainStart = (p: number): number => {
          let chainStart = p;
          while (chainStart > 0 && isWordChar(text[chainStart - 1])) chainStart--;
          // Extend left through '.' + word
          while (chainStart > 0 && text[chainStart - 1] === '.') {
            let wStart = chainStart - 2;
            while (wStart >= 0 && isWordChar(text[wStart])) wStart--;
            wStart++;
            if (wStart < chainStart - 1) { chainStart = wStart; } else break;
          }
          let result = chainStart;
          // Check for async/await keyword before the chain
          let kwScan = chainStart - 1;
          while (kwScan >= 0 && (text[kwScan] === ' ' || text[kwScan] === '\t')) kwScan--;
          for (const kw of ['async', 'await']) {
            const kwStart = kwScan - kw.length + 1;
            if (kwStart >= 0 && text.substring(kwStart, kwScan + 1) === kw) {
              if (kwStart === 0 || !isWordChar(text[kwStart - 1])) {
                result = kwStart;
                break;
              }
            }
          }
          return result;
        };

        if (text[L] === '(') {
          // Call expression: expand (...) to name(...)
          // Find the word/chain directly before '('
          if (scanPos >= 0 && isWordChar(text[scanPos])) {
            memberStart = findChainStart(scanPos);
          }
        } else {
          // text[L] === '{'
          if (scanPos >= 0 && text[scanPos] === ')') {
            // Method pattern: name(...) { ... }
            // Find matching '(' scanning backward
            let depth = 0;
            let parenOpen = -1;
            for (let i = scanPos; i >= 0; i--) {
              if (text[i] === ')') depth++;
              else if (text[i] === '(') {
                depth--;
                if (depth === 0) { parenOpen = i; break; }
              }
            }
            if (parenOpen > 0) {
              let p = parenOpen - 1;
              while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
              if (p >= 0 && isWordChar(text[p])) {
                memberStart = findChainStart(p);
              }
            }
          }
        }

        if (memberStart !== -1) {
          editor.selection = new vscode.Selection(doc.positionAt(memberStart), doc.positionAt(R));
          return;
        }
      }

      // --- Phase 0.6: Inner-first expansion ---
      // When selection is the inner content of a configured delimiter pair,
      // expand to include the delimiters.
      if (L !== R && L > 0 && R < len) {
        const leftChar = text[L - 1];
        if (innerFirstChars.includes(leftChar)) {
          const expectedClose = BS_INNER_CLOSERS[leftChar];
          if (expectedClose && text[R] === expectedClose) {
            editor.selection = new vscode.Selection(doc.positionAt(L - 1), doc.positionAt(R + 1));
            return;
          }
        }
      }

      const origL = L, origR = R;
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
        } else if (lastStrOpen !== -1 && L < len && text[L] === lastStrChar && !isEscapedAt(text, L)) {
          // Cursor is ON the closing quote of the most recently closed string
          oPos = lastStrOpen; cPos = L; qChar = lastStrChar;
        }

        if (oPos !== -1) {
          if (cPos === -1) {
            // Find closing quote from oPos+1 (j ≥ 1, so text[j-1] is always in-bounds)
            for (let j = oPos + 1; j < len; j++) {
              if (text[j] === qChar && !isEscapedAt(text, j)) { cPos = j; break; }
            }
          }
          if (cPos !== -1 && cPos >= R) { qStart = oPos; qEnd = cPos + 1; }
        }
      }

      // --- 2.5. HTML/XML tag pair scan ---
      const tagPair = findEnclosingTag(text, L, R);

      // --- 3. Pick tightest result ---
      let rStart: number, rEnd: number;
      const hasBracket = bStart !== -1 && bEnd !== -1;
      const hasQuote = qStart !== -1 && qEnd !== -1;
      const hasTag = tagPair !== null;

      const candidates: [number, number][] = [];
      if (hasBracket) candidates.push([bStart, bEnd]);
      if (hasQuote) candidates.push([qStart, qEnd]);
      if (hasTag) candidates.push([tagPair!.start, tagPair!.end]);

      if (candidates.length === 0) return;

      [rStart, rEnd] = candidates[0];
      for (let ci = 1; ci < candidates.length; ci++) {
        if ((candidates[ci][1] - candidates[ci][0]) < (rEnd - rStart)) {
          [rStart, rEnd] = candidates[ci];
        }
      }

      // Inner-first: for configured delimiters, select content without delimiters first
      if (rEnd - rStart > 2 && innerFirstChars.includes(text[rStart])) {
        const iStart = rStart + 1, iEnd = rEnd - 1;
        if (origL !== iStart || origR !== iEnd) {
          rStart = iStart;
          rEnd = iEnd;
        }
      }

      // --- 4. Include trailing comma or semicolon ---
      if (rEnd < len) {
        const trail = text[rEnd];
        if (trail === ',' || trail === ';') rEnd++;
      }

      editor.selection = new vscode.Selection(doc.positionAt(rStart), doc.positionAt(rEnd));
    })
  );

  let currentDebounceDelay = vscode.workspace
    .getConfiguration("dependencyDependent")
    .get<number>("debounceDelay") || 0;

  // Debounced refresh to prevent rapid updates when switching tabs quickly
  const makeRefresh = (delay: number) => debounce(() => {
    const locked = getLocked();
    if (locked === true) {
      return;
    }
    DepExplorerView.singleton.refresh();
  }, delay);

  let debouncedRefresh = makeRefresh(currentDebounceDelay);
  _debouncedRefresh = debouncedRefresh;

  // Recreate debounced refresh when debounceDelay config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("dependencyDependent.debounceDelay")) {
        _debouncedRefresh?.cancel();
        currentDebounceDelay = vscode.workspace
          .getConfiguration("dependencyDependent")
          .get<number>("debounceDelay") || 0;
        debouncedRefresh = makeRefresh(currentDebounceDelay);
        _debouncedRefresh = debouncedRefresh;
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => debouncedRefresh())
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
      "dependency-dependent.openAtLine",
      async (
        filePath: string,
        location:
          | number
          | {
              startLine: number;
              startCharacter: number;
              endLine: number;
              endCharacter: number;
            }
      ) => {
        try {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(filePath)
          );
          const editor = await vscode.window.showTextDocument(doc);

          let range: vscode.Range;
          if (typeof location === "number") {
            const safeLine = Math.min(Math.max(0, location), doc.lineCount - 1);
            range = doc.lineAt(safeLine).range;
          } else {
            const clampLine = (line: number) =>
              Math.min(Math.max(0, line), doc.lineCount - 1);
            const clampCharacter = (line: number, character: number) =>
              Math.min(
                Math.max(0, character),
                doc.lineAt(line).range.end.character
              );

            const startLine = clampLine(location.startLine);
            const endLine = clampLine(location.endLine);
            const startCharacter = clampCharacter(
              startLine,
              location.startCharacter
            );
            const endCharacter = clampCharacter(
              endLine,
              location.endCharacter
            );

            const start = new vscode.Position(startLine, startCharacter);
            const end = new vscode.Position(endLine, endCharacter);
            range =
              start.isAfter(end) || start.isEqual(end)
                ? doc.lineAt(startLine).range
                : new vscode.Range(start, end);
          }

          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch {
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
              log.appendLine('[Timeline] trackVariable command triggered');
              const editor = vscode.window.activeTextEditor;
              if (!editor) {
                  log.appendLine('[Timeline] No active editor');
                  return;
              }
              log.appendLine(`[Timeline] languageId: ${editor.document.languageId}, file: ${editor.document.fileName}`);
              if (editor.document.languageId !== 'vue') {
                  log.appendLine('[Timeline] Not a .vue file, skipping');
                  return;
              }

              const document = editor.document;
              const position = editor.selection.active;
              const wordRange = document.getWordRangeAtPosition(position, /[$\w]+/);
              if (!wordRange) {
                  log.appendLine(`[Timeline] No word at cursor position (line ${position.line}, char ${position.character})`);
                  vscode.window.showInformationMessage('Place cursor on a variable name to track.');
                  return;
              }

              let variableName = document.getText(wordRange);
              log.appendLine(`[Timeline] Word at cursor: "${variableName}"`);

              // Check if preceded by "this." — allow clicking on either "this" or the property
              const lineText = document.lineAt(position.line).text;
              const wordStart = wordRange.start.character;

              if (variableName === 'this') {
                  // User clicked on "this" — grab the property after the dot
                  const afterThis = lineText.substring(wordStart + 4); // skip "this"
                  const propMatch = afterThis.match(/^\.(\w+)/);
                  if (propMatch) {
                      variableName = propMatch[1];
                      log.appendLine(`[Timeline] Resolved "this." → "${variableName}"`);
                  } else {
                      log.appendLine('[Timeline] Cursor on "this" but no property after dot');
                      vscode.window.showInformationMessage('Place cursor on this.propertyName to track.');
                      return;
                  }
              } else if (wordStart >= 5 && lineText.substring(wordStart - 5, wordStart) === 'this.') {
                  log.appendLine(`[Timeline] Detected this.${variableName}`);
              } else {
                  log.appendLine(`[Timeline] Tracking by standalone name: "${variableName}"`);
              }

              // Skip $-prefixed properties
              if (variableName.startsWith('$')) {
                  log.appendLine(`[Timeline] Skipping $-prefixed property: ${variableName}`);
                  return;
              }

              log.appendLine(`[Timeline] Entering tracking mode for "${variableName}"...`);
              await vueTimelineProvider.enterTrackingMode(variableName, document);
              // Focus the timeline view
              vscode.commands.executeCommand('dependency-dependent-VueTimelineView.focus');
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

  // --- Vue：从 import 跳转到 <template> 中的组件标签 ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependency-dependent.vue.jumpToTemplateComponentTag",
      () => jumpToTemplateComponentTag()
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

        // --- Vue Option Auto-Generate: try first for .vue files ---
        if (doc.fileName.endsWith('.vue')) {
          const tsParser = TreeSitterParser.getInstance();
          const genResult = await generateVueOption(
            doc.getText(),
            doc.offsetAt(pos),
            tsParser
          );
          if (genResult) {
            const startPos = doc.positionAt(genResult.insertOffset);
            if (genResult.replaceLength) {
              const endPos = doc.positionAt(genResult.insertOffset + genResult.replaceLength);
              await editor.edit(eb => eb.replace(new vscode.Range(startPos, endPos), genResult.insertText));
            } else {
              await editor.edit(eb => eb.insert(startPos, genResult.insertText));
            }
            const msg = vscode.window.setStatusBarMessage(
              `$(check) Generated ${genResult.name} in ${genResult.section}`
            );
            setTimeout(() => msg.dispose(), 3000);
            return;
          }
        }

        // --- Original funcEnhance logic ---
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
