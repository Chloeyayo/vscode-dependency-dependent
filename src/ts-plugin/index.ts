/**
 * TypeScript Server Plugin for Vue SFC files.
 *
 * Provides native JS/TS language intelligence (completions, hover, diagnostics,
 * signature help) inside `<script>` blocks of `.vue` files by using the
 * "space-padding" technique: everything outside `<script>` is replaced with
 * spaces (preserving newlines) so character positions stay 1:1 with the
 * original file — no coordinate mapping needed.
 *
 * Coordination with extension-side providers:
 * - `this.` / `this.$` completions are yielded to VueOptionsCompletionProvider
 *   by returning `undefined` from `getCompletionsAtPosition`.
 */

import type ts from "typescript/lib/tsserverlibrary";

function init(modules: { typescript: typeof import("typescript/lib/tsserverlibrary") }) {
  const ts = modules.typescript;

  function create(info: ts.server.PluginCreateInfo) {
    const logger = info.project.projectService.logger;
    logger.info("[vue-ts-plugin] initializing");

    const host = info.languageServiceHost;
    const ls = info.languageService;

    // ------------------------------------------------------------------ //
    // Helpers                                                             //
    // ------------------------------------------------------------------ //

    function isVueFile(fileName: string): boolean {
      return fileName.endsWith(".vue");
    }

    /**
     * Extract the `<script>` block content from a Vue SFC and pad everything
     * else with spaces (keeping newlines intact) so that character offsets
     * remain identical to the original file.
     *
     * Returns `{ content, scriptKind }`.
     */
    function extractScript(text: string): { content: string; scriptKind: ts.ScriptKind } {
      // Match <script ...> with optional lang attribute
      const scriptOpenRe = /<script(\s[^>]*)?\s*>/i;
      const scriptCloseRe = /<\/script\s*>/i;

      const openMatch = scriptOpenRe.exec(text);
      if (!openMatch) {
        // No <script> block — return all spaces (preserving newlines)
        return { content: padAll(text), scriptKind: ts.ScriptKind.JS };
      }

      const attrs = openMatch[1] || "";
      const langMatch = /\blang\s*=\s*["']?(ts|typescript)["']?/i.exec(attrs);
      const scriptKind = langMatch ? ts.ScriptKind.TS : ts.ScriptKind.JS;

      const scriptBodyStart = openMatch.index + openMatch[0].length;

      const closeMatch = scriptCloseRe.exec(text.slice(scriptBodyStart));
      if (!closeMatch) {
        // Unclosed <script> — treat rest of file as script body
        const before = padAll(text.slice(0, scriptBodyStart));
        const body = text.slice(scriptBodyStart);
        return { content: before + body, scriptKind };
      }

      const scriptBodyEnd = scriptBodyStart + closeMatch.index;

      const before = padAll(text.slice(0, scriptBodyStart));
      const body = text.slice(scriptBodyStart, scriptBodyEnd);
      const after = padAll(text.slice(scriptBodyEnd));

      return { content: before + body + after, scriptKind };
    }

    /** Replace all characters with spaces, preserving `\n` for line structure. */
    function padAll(s: string): string {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        out += s[i] === "\n" ? "\n" : " ";
      }
      return out;
    }

    // Cache extracted results per-file to avoid re-parsing on every call
    const scriptCache = new Map<string, {
      version: string;
      content: string;
      scriptKind: ts.ScriptKind;
    }>();

    function getExtracted(fileName: string): { content: string; scriptKind: ts.ScriptKind } {
      const version = host.getScriptVersion(fileName);
      const cached = scriptCache.get(fileName);
      if (cached && cached.version === version) {
        return { content: cached.content, scriptKind: cached.scriptKind };
      }

      // Read via original snapshot (before our interception)
      const snap = origGetScriptSnapshot(fileName);
      if (!snap) {
        return { content: "", scriptKind: ts.ScriptKind.JS };
      }
      const text = snap.getText(0, snap.getLength());
      const result = extractScript(text);
      scriptCache.set(fileName, { version, ...result });
      return result;
    }

    // ------------------------------------------------------------------ //
    // Intercept LanguageServiceHost                                       //
    // ------------------------------------------------------------------ //

    // 1. getScriptKind — tell tsserver to treat .vue files as JS or TS
    const origGetScriptKind = host.getScriptKind?.bind(host);
    if (origGetScriptKind) {
      host.getScriptKind = (fileName: string) => {
        if (isVueFile(fileName)) {
          return getExtracted(fileName).scriptKind;
        }
        return origGetScriptKind(fileName);
      };
    }

    // 2. getScriptSnapshot — return space-padded content for .vue files
    const origGetScriptSnapshot = host.getScriptSnapshot.bind(host);
    host.getScriptSnapshot = (fileName: string) => {
      if (isVueFile(fileName)) {
        const { content } = getExtracted(fileName);
        return ts.ScriptSnapshot.fromString(content);
      }
      return origGetScriptSnapshot(fileName);
    };

    // ------------------------------------------------------------------ //
    // Proxy LanguageService methods                                       //
    // ------------------------------------------------------------------ //

    // Build a thin proxy that delegates everything to the real LS
    const proxy = Object.create(null) as ts.LanguageService;
    for (const k of Object.keys(ls) as Array<keyof ts.LanguageService>) {
      const val = ls[k];
      if (typeof val === "function") {
        (proxy as any)[k] = val.bind(ls);
      } else {
        (proxy as any)[k] = val;
      }
    }

    // 3. getCompletionsAtPosition — yield to VueOptionsCompletionProvider
    //    when the user types `this.` or `this.$`
    proxy.getCompletionsAtPosition = (
      fileName: string,
      position: number,
      options: ts.GetCompletionsAtPositionOptions | undefined,
    ) => {
      if (isVueFile(fileName)) {
        const { content } = getExtracted(fileName);

        // Check if position is inside the script body (non-space region)
        if (position >= content.length || content[position - 1] === undefined) {
          return undefined;
        }

        // Look backwards for `this.` or `this.$` pattern
        const lookback = content.slice(Math.max(0, position - 6), position);
        if (/this\.\$?$/.test(lookback)) {
          // Let the extension-side VueOptionsCompletionProvider handle it
          return undefined;
        }

        // Check if cursor is in a padded (non-script) region
        // Find the actual position in content — if it's a space-only line, skip
        const lineStart = content.lastIndexOf("\n", position - 1) + 1;
        const lineEnd = content.indexOf("\n", position);
        const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
        if (line.trim().length === 0) {
          return undefined;
        }
      }

      return ls.getCompletionsAtPosition(fileName, position, options);
    };

    // Filter diagnostics to only report within the <script> block
    const filterDiagnostics = (
      fileName: string,
      diagnostics: ts.Diagnostic[]
    ): ts.Diagnostic[] => {
      if (!isVueFile(fileName)) return diagnostics;
      const { content } = getExtracted(fileName);

      return diagnostics.filter(d => {
        if (d.start === undefined) return true;
        // Check that the diagnostic falls within actual script content (not padded spaces)
        const lineStart = content.lastIndexOf("\n", d.start - 1) + 1;
        const lineEnd = content.indexOf("\n", d.start);
        const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
        return line.trim().length > 0;
      });
    };

    proxy.getSemanticDiagnostics = (fileName: string) => {
      const diags = ls.getSemanticDiagnostics(fileName);
      return filterDiagnostics(fileName, diags);
    };

    proxy.getSyntacticDiagnostics = (fileName: string) => {
      const diags = ls.getSyntacticDiagnostics(fileName);
      return filterDiagnostics(fileName, diags as ts.Diagnostic[]) as ts.DiagnosticWithLocation[];
    };

    proxy.getSuggestionDiagnostics = (fileName: string) => {
      const diags = ls.getSuggestionDiagnostics(fileName);
      return filterDiagnostics(fileName, diags as ts.Diagnostic[]) as ts.DiagnosticWithLocation[];
    };

    logger.info("[vue-ts-plugin] ready");
    return proxy;
  }

  return { create };
}

export = init;
