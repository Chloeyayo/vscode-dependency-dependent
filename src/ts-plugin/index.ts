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
      /** 修改后文件中 WRAP_FUNC_DECL 的起始偏移（用于过滤 decl 区域的 token） */
      declStart: number;
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

    function isNodeModulesFile(fileName: string): boolean {
      return /[/\\]node_modules[/\\]/.test(fileName);
    }

    function padAll(s: string): string {
      return s.replace(/[^\n]/g, " ");
    }

    // ------------------------------------------------------------------ //
    // Position mapping                                                    //
    // ------------------------------------------------------------------ //
    //
    // 修改后文件结构（有 wrap 时）：
    //
    //  [0 .. objOpenPos-1]                    原样（template 等，padAll）
    //  [objOpenPos .. objOpenPos+prefixLen-1]  WRAP_PREFIX  "__v("
    //  [objOpenPos+prefixLen .. objClosePos+prefixLen]  原始对象体
    //  [objClosePos+prefixLen+1 .. +suffixLen]          WRAP_SUFFIX  ")"
    //  [objClosePos+prefixLen+suffixLen+1 .. declStart-1]  原始剩余（padAll）
    //  [declStart ..]                         WRAP_FUNC_DECL（追加到最末尾）
    //
    // ⚠️  declStart 之后的位置完全超出 originalContent 范围，
    //     toOriginal 对这部分直接夹到 origLen。

    function toModified(pos: number, w: WrapInfo): number {
      if (pos < w.objOpenPos) return pos;
      if (pos <= w.objClosePos) return pos + w.prefixLen;
      return pos + w.prefixLen + w.suffixLen;
    }

    /**
     * @param origLen originalContent.length，用于夹住 decl 区域坐标
     */
    function toOriginal(pos: number, w: WrapInfo, origLen: number): number {
      if (pos >= w.declStart) return origLen; // decl 区域 → 夹到末尾
      if (pos < w.objOpenPos) return pos;
      if (pos < w.objOpenPos + w.prefixLen) return w.objOpenPos;
      if (pos <= w.objClosePos + w.prefixLen) return pos - w.prefixLen;
      if (pos <= w.objClosePos + w.prefixLen + w.suffixLen) return w.objClosePos + 1;
      return pos - w.prefixLen - w.suffixLen;
    }

    function spanToOriginal(
      start: number,
      length: number,
      w: WrapInfo,
      origLen: number,
    ): { start: number; length: number } {
      const origStart = toOriginal(start, w, origLen);
      const origEnd = toOriginal(start + length, w, origLen);
      return { start: origStart, length: Math.max(0, origEnd - origStart) };
    }

    // ------------------------------------------------------------------ //
    // ThisType wrapping (JS only)                                         //
    // ------------------------------------------------------------------ //

    const WRAP_FUNC_NAME = "__v";
    const WRAP_FUNC_DECL = [
      "",
      "/**",
      " * @template D",
      " * @template M",
      " * @template C",
      " * @param {{data?(): D, computed?: C, methods?: M, [k:string]: any}" +
        " & ThisType<D & M & {[K in keyof C]: C[K] extends" +
        " (...args: any[]) => infer R ? R : C[K]}>} o",
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
        sf = ts.createSourceFile(
          "__vue__.js",
          scriptBody,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
      } catch {
        return null;
      }

      let objStart = -1;
      let objEnd = -1;
      ts.forEachChild(sf, (node) => {
        if (objStart >= 0) return;
        if (
          ts.isExportAssignment(node) &&
          !(node as any).isExportEquals
        ) {
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

      // ✅ 关键修复：DECL 追加到整个 paddedContent 末尾
      //    paddedContent 在插入 prefix/suffix 后长度增加了
      //    prefixLen + suffixLen，所以 declStart 是：
      const declStart =
        paddedContent.length + WRAP_PREFIX.length + WRAP_SUFFIX.length;

      const content =
        paddedContent.slice(0, objOpenPos) +
        WRAP_PREFIX +
        paddedContent.slice(objOpenPos, objClosePos + 1) +
        WRAP_SUFFIX +
        paddedContent.slice(objClosePos + 1) + // ← 原始剩余（padAll 区域）位置不变
        WRAP_FUNC_DECL; //                        ← 追加到最末尾

      return {
        content,
        wrapInfo: {
          objOpenPos,
          objClosePos,
          prefixLen: WRAP_PREFIX.length,
          suffixLen: WRAP_SUFFIX.length,
          declStart,
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
        return {
          content: c,
          originalContent: c,
          scriptKind: ts.ScriptKind.JS,
          scriptStart: 0,
          scriptEnd: 0,
          wrapInfo: null,
        };
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

      const wrapped = tryWrapExportDefault(
        originalContent,
        scriptBodyStart,
        scriptBodyEnd,
      );
      if (wrapped) {
        content = wrapped.content;
        wrapInfo = wrapped.wrapInfo;
      }

      return {
        content,
        originalContent,
        scriptKind,
        scriptStart: scriptBodyStart,
        scriptEnd: scriptBodyEnd,
        wrapInfo,
      };
    }

    const SCRIPT_CACHE_MAX = 200;
    const scriptCache = new Map<string, ExtractedScript & { version: string }>();

    function setScriptCache(
      fileName: string,
      value: ExtractedScript & { version: string },
    ): void {
      scriptCache.delete(fileName);
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
        return {
          content: "",
          originalContent: "",
          scriptKind: ts.ScriptKind.JS,
          scriptStart: 0,
          scriptEnd: 0,
          wrapInfo: null,
        };
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
        if (isVueFile(fileName)) return ts.ScriptKind.JS;
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

    const origGetCompilationSettings = host.getCompilationSettings.bind(host);
    host.getCompilationSettings = () => {
      const s = origGetCompilationSettings();
      // ✅ ...s 展开保留 paths / baseUrl / moduleResolution，
      //    只叠加我们需要的标志。
      return {
        ...s,
        allowJs: true,
        checkJs: true,
        noImplicitThis: true,
        noImplicitAny: false,
        strictNullChecks: false,
        strictFunctionTypes: false,
        strictPropertyInitialization: false,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      };
    };

    // ✅ FIX 1：补全 resolveModuleNames
    //
    // tsserver 插件的 host 通常没有实现 resolveModuleNames，
    // 导致 TypeScript 内部走"默认解析"，不认识 @/ 别名。
    // 我们手动实现，用当前 compilerOptions（含 paths/baseUrl）调用
    // ts.resolveModuleName，这样 @/ 就能正确解析。
    if (!host.resolveModuleNames) {
      host.resolveModuleNames = (
        moduleNames: string[],
        containingFile: string,
        _reusedNames: string[] | undefined,
        _redirectedReference: ts.ResolvedProjectReference | undefined,
        compilerOptions: ts.CompilerOptions,
      ): (ts.ResolvedModule | undefined)[] => {
        return moduleNames.map((moduleName) => {
          try {
            const { resolvedModule } = ts.resolveModuleName(
              moduleName,
              containingFile,
              compilerOptions,
              host as ts.ModuleResolutionHost,
            );
            return resolvedModule;
          } catch {
            return undefined;
          }
        });
      };
    }

    const origGetScriptVersion = host.getScriptVersion.bind(host);
    const vueContentVersions = new Map<
      string,
      { contentHash: string; version: number }
    >();

    host.getScriptVersion = (fileName: string) => {
      if (isVueFile(fileName)) {
        const snap = origGetScriptSnapshot(fileName);
        if (!snap) return origGetScriptVersion(fileName);

        // 性能关键：getScriptVersion 可能被频繁调用。
        // 这里不要读取整个文件内容（会产生巨大字符串分配并拖慢/拖挂 tsserver），
        // 只取长度 + 头尾片段作为指纹（与之前 text.length + slice(0,100) + slice(-100) 的语义一致）。
        const len = snap.getLength();
        const headEnd = Math.min(100, len);
        const tailStart = Math.max(0, len - 100);
        const head = snap.getText(0, headEnd);
        const tail = snap.getText(tailStart, len);
        const contentHash = len + ":" + head + tail;

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
        (proxy as any)[k] = (val as Function).bind(ls);
      } else {
        (proxy as any)[k] = val;
      }
    }

    // ------------------------------------------------------------------ //
    // 统一反向映射工具                                                     //
    // ------------------------------------------------------------------ //

    function backSpan(
      start: number,
      length: number,
      ext: ExtractedScript,
    ): { start: number; length: number } {
      if (!ext.wrapInfo) return { start, length };
      return spanToOriginal(
        start,
        length,
        ext.wrapInfo,
        ext.originalContent.length,
      );
    }

    function backPos(pos: number, ext: ExtractedScript): number {
      if (!ext.wrapInfo) return pos;
      return toOriginal(pos, ext.wrapInfo, ext.originalContent.length);
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
        const beforeCursor = originalContent.slice(
          Math.max(lineStart, position - 256),
          position,
        );
        if (/\bthis\.\$[\w]*$/.test(beforeCursor)) return undefined;

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getCompletionsAtPosition(fileName, mapped, options);

        if (result && wrapInfo) {
          return {
            ...result,
            entries: result.entries.map((e) => {
              if (e.replacementSpan) {
                const orig = backSpan(
                  e.replacementSpan.start,
                  e.replacementSpan.length,
                  ext,
                );
                return {
                  ...e,
                  replacementSpan: { start: orig.start, length: orig.length },
                };
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
        const ext = getExtracted(fileName);
        const mapped = ext.wrapInfo
          ? toModified(position, ext.wrapInfo)
          : position;
        return ls.getCompletionEntryDetails(
          fileName,
          mapped,
          entryName,
          formatOptions,
          source,
          preferences,
          data,
        );
      }
      return ls.getCompletionEntryDetails(
        fileName,
        position,
        entryName,
        formatOptions,
        source,
        preferences,
        data,
      );
    };

    // -- Quick Info (hover) -------------------------------------------

    proxy.getQuickInfoAtPosition = (fileName: string, position: number) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { scriptStart, scriptEnd, wrapInfo } = ext;

        if (scriptStart === 0 && scriptEnd === 0) return undefined;
        if (position < scriptStart || position > scriptEnd) return undefined;

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getQuickInfoAtPosition(fileName, mapped);

        if (result && wrapInfo) {
          const orig = backSpan(
            result.textSpan.start,
            result.textSpan.length,
            ext,
          );
          return { ...result, textSpan: { start: orig.start, length: orig.length } };
        }

        return result;
      }

      return ls.getQuickInfoAtPosition(fileName, position);
    };

    // -- Definitions --------------------------------------------------

    proxy.getDefinitionAndBoundSpan = (fileName: string, position: number) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { wrapInfo } = ext;

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getDefinitionAndBoundSpan(fileName, mapped);

        if (result && wrapInfo) {
          const origTextSpan = backSpan(
            result.textSpan.start,
            result.textSpan.length,
            ext,
          );
          const definitions = result.definitions?.map((d) => {
            if (d.fileName === fileName) {
              const s = backSpan(d.textSpan.start, d.textSpan.length, ext);
              return { ...d, textSpan: { start: s.start, length: s.length } };
            }
            if (isVueFile(d.fileName)) {
              const otherExt = getExtracted(d.fileName);
              if (otherExt.wrapInfo) {
                const s = backSpan(d.textSpan.start, d.textSpan.length, otherExt);
                return { ...d, textSpan: { start: s.start, length: s.length } };
              }
            }
            return d;
          });
          return {
            textSpan: { start: origTextSpan.start, length: origTextSpan.length },
            definitions,
          };
        }

        return result;
      }

      return ls.getDefinitionAndBoundSpan(fileName, position);
    };

    // -- Diagnostics --------------------------------------------------

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

    // -- Classifications (semantic / syntactic highlighting) ----------
    //
    // ✅ FIX 2：正确过滤 WRAP_FUNC_DECL 区域的 token，
    //           并把其余 token 的坐标映射回原始文件。

    proxy.getEncodedSemanticClassifications = (
      fileName: string,
      span: ts.TextSpan,
      format?: ts.SemanticClassificationFormat,
    ) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { wrapInfo, originalContent } = ext;

        // 把请求 span 映射到修改后坐标
        let mappedSpan = span;
        if (wrapInfo) {
          const modStart = toModified(span.start, wrapInfo);
          const modEnd = toModified(span.start + span.length, wrapInfo);
          mappedSpan = { start: modStart, length: modEnd - modStart };
        }

        const result = ls.getEncodedSemanticClassifications(
          fileName,
          mappedSpan,
          format,
        );

        if (!wrapInfo || result.spans.length === 0) return result;

        const origLen = originalContent.length;
        const newSpans: number[] = [];
        for (let i = 0; i + 2 < result.spans.length; i += 3) {
          const mStart = result.spans[i];
          const mLen = result.spans[i + 1];
          const kind = result.spans[i + 2];

          // ✅ 跳过落在 WRAP_FUNC_DECL 区域的 token
          if (mStart >= wrapInfo.declStart) continue;

          const orig = spanToOriginal(mStart, mLen, wrapInfo, origLen);
          if (orig.length <= 0) continue;

          newSpans.push(orig.start, orig.length, kind);
        }

        return { spans: newSpans, endOfLineState: result.endOfLineState };
      }

      return ls.getEncodedSemanticClassifications(fileName, span, format);
    };

    proxy.getEncodedSyntacticClassifications = (
      fileName: string,
      span: ts.TextSpan,
    ) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { wrapInfo, originalContent } = ext;

        let mappedSpan = span;
        if (wrapInfo) {
          const modStart = toModified(span.start, wrapInfo);
          const modEnd = toModified(span.start + span.length, wrapInfo);
          mappedSpan = { start: modStart, length: modEnd - modStart };
        }

        const result = ls.getEncodedSyntacticClassifications(
          fileName,
          mappedSpan,
        );

        if (!wrapInfo || result.spans.length === 0) return result;

        const origLen = originalContent.length;
        const newSpans: number[] = [];
        for (let i = 0; i + 2 < result.spans.length; i += 3) {
          const mStart = result.spans[i];
          const mLen = result.spans[i + 1];
          const kind = result.spans[i + 2];

          if (mStart >= wrapInfo.declStart) continue;

          const orig = spanToOriginal(mStart, mLen, wrapInfo, origLen);
          if (orig.length <= 0) continue;

          newSpans.push(orig.start, orig.length, kind);
        }

        return { spans: newSpans, endOfLineState: result.endOfLineState };
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
        const ext = getExtracted(fileName);
        const mapped = ext.wrapInfo
          ? toModified(position, ext.wrapInfo)
          : position;
        return ls.getSignatureHelpItems(fileName, mapped, options);
      }
      return ls.getSignatureHelpItems(fileName, position, options);
    };

    logger.info("[vue-ts-plugin] ready");
    return proxy;
  }

  function getExternalFiles(project: ts.server.Project): string[] {
    return project.getFileNames().filter((f) => f.endsWith(".vue"));
  }

  return { create, getExternalFiles };
}

export = init;
