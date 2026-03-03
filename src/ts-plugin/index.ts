import type ts from "typescript/lib/tsserverlibrary";

function init(modules: { typescript: typeof import("typescript/lib/tsserverlibrary") }) {
  const ts = modules.typescript;

  function create(info: ts.server.PluginCreateInfo) {
    const logger = info.project.projectService.logger;
    logger.info("[vue-ts-plugin] initializing");

    const host = info.languageServiceHost;
    const ls = info.languageService;

    // ------------------------------------------------------------------ //
    // Types                                                               //
    // ------------------------------------------------------------------ //

    interface WrapInfo {
      objOpenPos: number;
      objClosePos: number;
      prefixLen: number;
      suffixLen: number;
    }

    interface ExtractedScript {
      content: string;
      originalContent: string;
      scriptKind: ts.ScriptKind;
      scriptStart: number;
      scriptEnd: number;
      wrapInfo: WrapInfo | null;
    }

    // ------------------------------------------------------------------ //
    // Helpers                                                             //
    // ------------------------------------------------------------------ //

    function isVueFile(fileName: string): boolean {
      return fileName.endsWith(".vue");
    }

    // ✅ FIX 1 — helper to detect node_modules paths
    function isNodeModulesFile(fileName: string): boolean {
      return /[/\\]node_modules[/\\]/.test(fileName);
    }

    function padAll(s: string): string {
      return s.replace(/[^\n]/g, " ");
    }

    // ------------------------------------------------------------------ //
    // Position mapping                                                    //
    // ------------------------------------------------------------------ //

    function toModified(pos: number, w: WrapInfo): number {
      if (pos < w.objOpenPos) return pos;
      if (pos <= w.objClosePos) return pos + w.prefixLen;
      return pos + w.prefixLen + w.suffixLen;
    }

    function toOriginal(pos: number, w: WrapInfo): number {
      if (pos < w.objOpenPos) return pos;
      if (pos < w.objOpenPos + w.prefixLen) return w.objOpenPos;
      if (pos <= w.objClosePos + w.prefixLen) return pos - w.prefixLen;
      if (pos <= w.objClosePos + w.prefixLen + w.suffixLen) return w.objClosePos + 1;
      return pos - w.prefixLen - w.suffixLen;
    }

    function spanToOriginal(start: number, length: number, w: WrapInfo): { start: number; length: number } {
      const origStart = toOriginal(start, w);
      const origEnd = toOriginal(start + length, w);
      return { start: origStart, length: Math.max(0, origEnd - origStart) };
    }

    // ------------------------------------------------------------------ //
    // ThisType wrapping (JS only)                                         //
    // ------------------------------------------------------------------ //

    const WRAP_FUNC_NAME = "__v";
    // @ts-ignore
    const WRAP_FUNC_DECL = [
      "",
      "/**",
      " * @template D",
      " * @template M",
      " * @template C",
      " * @param {{data?(): D, computed?: C, methods?: M, [k:string]: any} & ThisType<D & M & {[K in keyof C]: C[K] extends (...args: any[]) => infer R ? R : C[K]}>} o",
      " * @returns {typeof o}",
      " */",
      `function ${WRAP_FUNC_NAME}(o) { return o; }`,
      "",
    ].join("\n");

    const WRAP_PREFIX = `${WRAP_FUNC_NAME}(`;
    const WRAP_SUFFIX = ")";

    function tryWrapExportDefault(
      paddedContent: string,
      scriptStart: number,
      scriptEnd: number,
    ): { content: string; wrapInfo: WrapInfo } | null {
      const scriptBody = paddedContent.slice(scriptStart, scriptEnd);

      let sf: ts.SourceFile;
      try {
        sf = ts.createSourceFile("__vue__.js", scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      } catch {
        return null;
      }

      let objStart = -1;
      let objEnd = -1;
      ts.forEachChild(sf, (node) => {
        if (objStart >= 0) return;
        if (ts.isExportAssignment(node) && !(node as any).isExportEquals) {
          const expr = (node as ts.ExportAssignment).expression;
          if (ts.isObjectLiteralExpression(expr)) {
            objStart = expr.getStart(sf);
            objEnd = expr.getEnd();
          }
        }
      });

      if (objStart < 0) return null;

      const objOpenPos = scriptStart + objStart;
      const objClosePos = scriptStart + objEnd - 1;

      const content =
        paddedContent.slice(0, objOpenPos) +
        WRAP_PREFIX +
        paddedContent.slice(objOpenPos, objClosePos + 1) +
        WRAP_SUFFIX +
        paddedContent.slice(objClosePos + 1) +
        WRAP_FUNC_DECL;

      return {
        content,
        wrapInfo: {
          objOpenPos,
          objClosePos,
          prefixLen: WRAP_PREFIX.length,
          suffixLen: WRAP_SUFFIX.length,
        },
      };
    }

    // ------------------------------------------------------------------ //
    // Script extraction + caching                                         //
    // ------------------------------------------------------------------ //

    function extractScript(text: string): ExtractedScript {
      const scriptOpenRe = /<script(\s[^>]*)?\s*>/i;
      const scriptCloseRe = /<\/script\s*>/i;

      const openMatch = scriptOpenRe.exec(text);
      if (!openMatch) {
        const c = padAll(text);
        return { content: c, originalContent: c, scriptKind: ts.ScriptKind.JS, scriptStart: 0, scriptEnd: 0, wrapInfo: null };
      }

      const scriptKind = ts.ScriptKind.JS;
      const scriptBodyStart = openMatch.index + openMatch[0].length;

      const closeMatch = scriptCloseRe.exec(text.slice(scriptBodyStart));
      let originalContent: string;
      let scriptBodyEnd: number;

      if (!closeMatch) {
        const before = padAll(text.slice(0, scriptBodyStart));
        const body = text.slice(scriptBodyStart);
        originalContent = before + body;
        scriptBodyEnd = text.length;
      } else {
        scriptBodyEnd = scriptBodyStart + closeMatch.index;
        const before = padAll(text.slice(0, scriptBodyStart));
        const body = text.slice(scriptBodyStart, scriptBodyEnd);
        const after = padAll(text.slice(scriptBodyEnd));
        originalContent = before + body + after;
      }

      let content = originalContent;
      let wrapInfo: WrapInfo | null = null;

      const wrapped = tryWrapExportDefault(originalContent, scriptBodyStart, scriptBodyEnd);
      if (wrapped) {
        content = wrapped.content;
        wrapInfo = wrapped.wrapInfo;
      }

      return { content, originalContent, scriptKind, scriptStart: scriptBodyStart, scriptEnd: scriptBodyEnd, wrapInfo };
    }

    const SCRIPT_CACHE_MAX = 200;
    const scriptCache = new Map<string, ExtractedScript & { version: string }>();

    function setScriptCache(fileName: string, value: ExtractedScript & { version: string }): void {
      if (scriptCache.has(fileName)) {
        scriptCache.delete(fileName);
      }
      scriptCache.set(fileName, value);

      while (scriptCache.size > SCRIPT_CACHE_MAX) {
        const oldest = scriptCache.keys().next().value;
        if (oldest === undefined) break;
        scriptCache.delete(oldest);
      }
    }

    function getExtracted(fileName: string): ExtractedScript {
      const version = host.getScriptVersion(fileName);
      const cached = scriptCache.get(fileName);
      if (cached && cached.version === version) {
        scriptCache.delete(fileName);
        scriptCache.set(fileName, cached);
        return cached;
      }

      const snap = origGetScriptSnapshot(fileName);
      if (!snap) {
        return { content: "", originalContent: "", scriptKind: ts.ScriptKind.JS, scriptStart: 0, scriptEnd: 0, wrapInfo: null };
      }
      const text = snap.getText(0, snap.getLength());
      const result = extractScript(text);
      setScriptCache(fileName, { version, ...result });
      return result;
    }

    // ------------------------------------------------------------------ //
    // Intercept LanguageServiceHost                                       //
    // ------------------------------------------------------------------ //

    const origGetScriptKind = host.getScriptKind?.bind(host);
    if (origGetScriptKind) {
      host.getScriptKind = (fileName: string) => {
        if (isVueFile(fileName)) {
          return ts.ScriptKind.JS;
        }
        return origGetScriptKind(fileName);
      };
    }

    const origGetScriptSnapshot = host.getScriptSnapshot.bind(host);
    host.getScriptSnapshot = (fileName: string) => {
      if (isVueFile(fileName)) {
        const { content } = getExtracted(fileName);
        return ts.ScriptSnapshot.fromString(content);
      }
      return origGetScriptSnapshot(fileName);
    };

    // ✅ FIX 2 — relax strict flags that produce cascading noise in JS
    //
    //  Problem:  the project (or TS defaults) may enable `strict`, which
    //            activates noImplicitAny  → 7005/7006/7053 on every un-typed param
    //            activates strictNullChecks → `[]` infers as `never[]`,
    //                                        `null` infers as literal type `null`
    //            These are unusable for Vue 2 Options-API JS components.
    //
    //  Fix:     explicitly disable the problematic sub-flags while keeping
    //           noImplicitThis (required for ThisType<> to work) and adding
    //           skipLibCheck to silence node_modules declaration-file errors.
    const origGetCompilationSettings = host.getCompilationSettings.bind(host);
    host.getCompilationSettings = () => {
      const s = origGetCompilationSettings();
      return {
        ...s,
        allowJs: true,
        checkJs: true,
        // keep ThisType working
        noImplicitThis: true,
        // ── relax the strict sub-flags ──
        noImplicitAny: false,          // stops 7005 / 7006 / 7053
        strictNullChecks: false,       // [] → any[] instead of never[]
                                       // null assignable to any type
        strictFunctionTypes: false,
        strictPropertyInitialization: false,
        // ── silence node_modules ──
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      };
    };

    const origGetScriptVersion = host.getScriptVersion.bind(host);
    const vueContentVersions = new Map<string, { contentHash: string; version: number }>();

    host.getScriptVersion = (fileName: string) => {
      if (isVueFile(fileName)) {
        const snap = origGetScriptSnapshot(fileName);
        if (!snap) return origGetScriptVersion(fileName);

        const text = snap.getText(0, snap.getLength());
        const contentHash = text.length + ":" + text.slice(0, 100) + text.slice(-100);

        const prev = vueContentVersions.get(fileName);
        if (prev && prev.contentHash === contentHash) {
          return String(prev.version);
        }

        const newVersion = prev ? prev.version + 1 : 1;
        vueContentVersions.set(fileName, { contentHash, version: newVersion });
        return String(newVersion);
      }
      return origGetScriptVersion(fileName);
    };

    // ------------------------------------------------------------------ //
    // Proxy LanguageService methods                                       //
    // ------------------------------------------------------------------ //

    const proxy = Object.create(null) as ts.LanguageService;
    for (const k of Object.keys(ls) as Array<keyof ts.LanguageService>) {
      const val = ls[k];
      if (typeof val === "function") {
        (proxy as any)[k] = val.bind(ls);
      } else {
        (proxy as any)[k] = val;
      }
    }

    // -- Completions --------------------------------------------------

    proxy.getCompletionsAtPosition = (
      fileName: string,
      position: number,
      options: ts.GetCompletionsAtPositionOptions | undefined,
    ) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { originalContent, scriptStart, scriptEnd, wrapInfo } = ext;

        if (scriptStart === 0 && scriptEnd === 0) return undefined;
        if (position < scriptStart || position > scriptEnd) return undefined;

        const lineStart = originalContent.lastIndexOf("\n", position - 1) + 1;
        const beforeCursor = originalContent.slice(Math.max(lineStart, position - 256), position);

        if (/\bthis\.\$[\w]*$/.test(beforeCursor)) {
          return undefined;
        }

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getCompletionsAtPosition(fileName, mapped, options);

        if (result && wrapInfo) {
          return {
            ...result,
            entries: result.entries.map(e => {
              if (e.replacementSpan) {
                const orig = spanToOriginal(e.replacementSpan.start, e.replacementSpan.length, wrapInfo);
                return { ...e, replacementSpan: { start: orig.start, length: orig.length } };
              }
              return e;
            }),
          };
        }

        return result;
      }

      return ls.getCompletionsAtPosition(fileName, position, options);
    };

    proxy.getCompletionEntryDetails = (
      fileName: string,
      position: number,
      entryName: string,
      formatOptions: ts.FormatCodeOptions | ts.FormatCodeSettings | undefined,
      source: string | undefined,
      preferences: ts.UserPreferences | undefined,
      data?: ts.CompletionEntryData,
    ) => {
      if (isVueFile(fileName)) {
        const { wrapInfo } = getExtracted(fileName);
        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        return ls.getCompletionEntryDetails(fileName, mapped, entryName, formatOptions, source, preferences, data);
      }
      return ls.getCompletionEntryDetails(fileName, position, entryName, formatOptions, source, preferences, data);
    };

    // -- Quick Info (hover) -------------------------------------------

    proxy.getQuickInfoAtPosition = (
      fileName: string,
      position: number,
    ) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { scriptStart, scriptEnd, wrapInfo } = ext;

        if (scriptStart === 0 && scriptEnd === 0) return undefined;
        if (position < scriptStart || position > scriptEnd) return undefined;

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getQuickInfoAtPosition(fileName, mapped);

        if (result && wrapInfo) {
          const orig = spanToOriginal(result.textSpan.start, result.textSpan.length, wrapInfo);
          return { ...result, textSpan: { start: orig.start, length: orig.length } };
        }

        return result;
      }

      return ls.getQuickInfoAtPosition(fileName, position);
    };

    // -- Definitions --------------------------------------------------

    proxy.getDefinitionAndBoundSpan = (
      fileName: string,
      position: number,
    ) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { wrapInfo } = ext;

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getDefinitionAndBoundSpan(fileName, mapped);

        if (result && wrapInfo) {
          const origTextSpan = spanToOriginal(result.textSpan.start, result.textSpan.length, wrapInfo);
          const definitions = result.definitions?.map(d => {
            if (d.fileName === fileName) {
              const origSpan = spanToOriginal(d.textSpan.start, d.textSpan.length, wrapInfo);
              return { ...d, textSpan: { start: origSpan.start, length: origSpan.length } };
            }
            if (isVueFile(d.fileName)) {
              const otherExt = getExtracted(d.fileName);
              if (otherExt.wrapInfo) {
                const origSpan = spanToOriginal(d.textSpan.start, d.textSpan.length, otherExt.wrapInfo);
                return { ...d, textSpan: { start: origSpan.start, length: origSpan.length } };
              }
            }
            return d;
          });
          return { textSpan: { start: origTextSpan.start, length: origTextSpan.length }, definitions };
        }

        return result;
      }

      return ls.getDefinitionAndBoundSpan(fileName, position);
    };

    // -- Diagnostics --------------------------------------------------
    // Suppress ALL diagnostics for Vue files (JS doesn't need TS checking)
    // and for node_modules files (not actionable by the user).

    proxy.getSemanticDiagnostics = (fileName: string) => {
      if (isVueFile(fileName) || isNodeModulesFile(fileName)) return [];
      return ls.getSemanticDiagnostics(fileName);
    };

    proxy.getSyntacticDiagnostics = (fileName: string) => {
      if (isVueFile(fileName) || isNodeModulesFile(fileName)) return [];
      return ls.getSyntacticDiagnostics(fileName);
    };

    proxy.getSuggestionDiagnostics = (fileName: string) => {
      if (isVueFile(fileName) || isNodeModulesFile(fileName)) return [];
      return ls.getSuggestionDiagnostics(fileName);
    };

    // -- Classifications (semantic highlighting) ----------------------
    // Map token spans from wrapped coordinates back to original coordinates.

    proxy.getEncodedSemanticClassifications = (
      fileName: string,
      span: ts.TextSpan,
      format?: ts.SemanticClassificationFormat,
    ) => {
      if (isVueFile(fileName)) {
        const { wrapInfo } = getExtracted(fileName);

        let mappedSpan = span;
        if (wrapInfo) {
          const modStart = toModified(span.start, wrapInfo);
          const modEnd = toModified(span.start + span.length, wrapInfo);
          mappedSpan = { start: modStart, length: modEnd - modStart };
        }

        const result = ls.getEncodedSemanticClassifications(fileName, mappedSpan, format);

        if (wrapInfo && result.spans.length > 0) {
          const newSpans: number[] = [];
          for (let i = 0; i < result.spans.length; i += 3) {
            const orig = spanToOriginal(result.spans[i], result.spans[i + 1], wrapInfo);
            if (orig.length > 0) {
              newSpans.push(orig.start, orig.length, result.spans[i + 2]);
            }
          }
          return { spans: newSpans, endOfLineState: result.endOfLineState };
        }

        return result;
      }

      return ls.getEncodedSemanticClassifications(fileName, span, format);
    };

    proxy.getEncodedSyntacticClassifications = (
      fileName: string,
      span: ts.TextSpan,
    ) => {
      if (isVueFile(fileName)) {
        const { wrapInfo } = getExtracted(fileName);

        let mappedSpan = span;
        if (wrapInfo) {
          const modStart = toModified(span.start, wrapInfo);
          const modEnd = toModified(span.start + span.length, wrapInfo);
          mappedSpan = { start: modStart, length: modEnd - modStart };
        }

        const result = ls.getEncodedSyntacticClassifications(fileName, mappedSpan);

        if (wrapInfo && result.spans.length > 0) {
          const newSpans: number[] = [];
          for (let i = 0; i < result.spans.length; i += 3) {
            const orig = spanToOriginal(result.spans[i], result.spans[i + 1], wrapInfo);
            if (orig.length > 0) {
              newSpans.push(orig.start, orig.length, result.spans[i + 2]);
            }
          }
          return { spans: newSpans, endOfLineState: result.endOfLineState };
        }

        return result;
      }

      return ls.getEncodedSyntacticClassifications(fileName, span);
    };

    // -- Signature Help -----------------------------------------------

    proxy.getSignatureHelpItems = (
      fileName: string,
      position: number,
      options: ts.SignatureHelpItemsOptions | undefined,
    ) => {
      if (isVueFile(fileName)) {
        const { wrapInfo } = getExtracted(fileName);
        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        return ls.getSignatureHelpItems(fileName, mapped, options);
      }
      return ls.getSignatureHelpItems(fileName, position, options);
    };

    logger.info("[vue-ts-plugin] ready");
    return proxy;
  }

  function getExternalFiles(project: ts.server.Project): string[] {
    return project.getFileNames().filter(f => f.endsWith(".vue"));
  }

  return { create, getExternalFiles };
}

export = init;