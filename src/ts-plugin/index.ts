import * as path from "path";
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
      return fileName.toLowerCase().endsWith(".vue");
    }

    function isNodeModulesFile(fileName: string): boolean {
      return /[/\\]node_modules[/\\]/.test(fileName);
    }

    function padAll(s: string): string {
      return s.replace(/[^\n]/g, " ");
    }

    function getCurrentDirectory(): string {
      try {
        const cwd = host.getCurrentDirectory?.();
        if (cwd) return cwd;
      } catch {}
      try {
        const cwd = info.project.getCurrentDirectory?.();
        if (cwd) return cwd;
      } catch {}
      return process.cwd();
    }

    function normalizePath(fileName: string): string {
      return path.normalize(fileName);
    }

    function directoryExists(dirName: string): boolean {
      try {
        if (host.directoryExists) return host.directoryExists(dirName);
      } catch {}
      return ts.sys.directoryExists(dirName);
    }

    function fileExists(fileName: string): boolean {
      try {
        if (host.fileExists) return host.fileExists(fileName);
      } catch {}
      return ts.sys.fileExists(fileName);
    }

    function dedupePaths(paths: string[]): string[] {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const candidate of paths) {
        const normalized = normalizePath(candidate);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
      }
      return result;
    }

    const projectRootCache = new Map<string, string[]>();
    const resolutionMissLogCache = new Set<string>();

    function getConfiguredProjectRoot(): string | undefined {
      try {
        const projectName = info.project.getProjectName?.();
        if (!projectName) return undefined;
        const normalized = normalizePath(projectName);
        if (/\.json$/i.test(normalized) && fileExists(normalized)) {
          return normalizePath(path.dirname(normalized));
        }
        if (directoryExists(normalized)) {
          return normalized;
        }
      } catch {}
      return undefined;
    }

    function findNearestProjectRoot(startDir: string): string | undefined {
      let current = normalizePath(startDir);
      while (true) {
        if (
          fileExists(path.join(current, "tsconfig.json")) ||
          fileExists(path.join(current, "jsconfig.json")) ||
          fileExists(path.join(current, "package.json"))
        ) {
          return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    }

    function getProjectRoots(containingFile: string): string[] {
      const cacheKey = normalizePath(path.dirname(containingFile));
      const cached = projectRootCache.get(cacheKey);
      if (cached) return cached;

      const roots = dedupePaths([
        getConfiguredProjectRoot() ?? "",
        findNearestProjectRoot(path.dirname(containingFile)) ?? "",
        getCurrentDirectory(),
      ].filter(Boolean));

      const result = roots.length > 0 ? roots : [cacheKey];
      projectRootCache.set(cacheKey, result);
      return result;
    }

    function getBaseDirectories(
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
    ): string[] {
      const baseUrl = compilerOptions.baseUrl;
      const projectRoots = getProjectRoots(containingFile);
      if (!baseUrl) return projectRoots;
      if (path.isAbsolute(baseUrl)) return [normalizePath(baseUrl)];
      return dedupePaths(projectRoots.map((root) => path.resolve(root, baseUrl)));
    }

    function logResolutionMiss(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
    ): void {
      if (!moduleName.startsWith("@/") && !moduleName.endsWith(".vue")) return;
      const key = `${normalizePath(containingFile)}::${moduleName}`;
      if (resolutionMissLogCache.has(key)) return;
      resolutionMissLogCache.add(key);
      if (resolutionMissLogCache.size > 200) {
        const oldest = resolutionMissLogCache.values().next().value;
        if (oldest !== undefined) resolutionMissLogCache.delete(oldest);
      }
      logger.info(
        `[vue-ts-plugin] resolve miss module=${moduleName} containing=${normalizePath(containingFile)} baseUrl=${compilerOptions.baseUrl ?? ""} projectRoots=${getProjectRoots(containingFile).join("|")}`,
      );
    }

    function getPathPatternMatch(
      pattern: string,
      moduleName: string,
    ): string | null {
      const starIndex = pattern.indexOf("*");
      if (starIndex < 0) return pattern === moduleName ? "" : null;

      const prefix = pattern.slice(0, starIndex);
      const suffix = pattern.slice(starIndex + 1);
      if (!moduleName.startsWith(prefix) || !moduleName.endsWith(suffix)) {
        return null;
      }
      return moduleName.slice(prefix.length, moduleName.length - suffix.length);
    }

    function applyPathPattern(pattern: string, starMatch: string): string {
      return pattern.includes("*") ? pattern.replace("*", starMatch) : pattern;
    }

    function tryResolveVueFile(candidatePath: string): string | undefined {
      const normalized = normalizePath(candidatePath);
      const ext = path.extname(normalized).toLowerCase();

      if (ext) {
        if (ext !== ".vue") return undefined;
        return fileExists(normalized) ? normalized : undefined;
      }

      const candidates = [
        `${normalized}.vue`,
        path.join(normalized, "index.vue"),
      ];
      for (const candidate of candidates) {
        if (fileExists(candidate)) return normalizePath(candidate);
      }
      return undefined;
    }

    function tryResolveVueModuleByPaths(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
    ): string | undefined {
      const paths = compilerOptions.paths ?? {};
      const baseDirectories = getBaseDirectories(containingFile, compilerOptions);

      for (const baseDirectory of baseDirectories) {
        for (const [pattern, replacements] of Object.entries(paths)) {
          const starMatch = getPathPatternMatch(pattern, moduleName);
          if (starMatch === null) continue;

          for (const replacement of replacements) {
            const mapped = applyPathPattern(replacement, starMatch);
            const resolved = tryResolveVueFile(
              path.resolve(baseDirectory, mapped),
            );
            if (resolved) return resolved;
          }
        }
      }

      for (const baseDirectory of baseDirectories) {
        const resolved = tryResolveVueFile(path.resolve(baseDirectory, moduleName));
        if (resolved) return resolved;
      }
      return undefined;
    }

    function tryResolveVueModuleManually(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
    ): ts.ResolvedModuleFull | undefined {
      let resolvedFileName: string | undefined;

      if (moduleName.startsWith(".") || path.isAbsolute(moduleName)) {
        resolvedFileName = tryResolveVueFile(
          path.resolve(path.dirname(containingFile), moduleName),
        );
      } else {
        resolvedFileName = tryResolveVueModuleByPaths(
          moduleName,
          containingFile,
          compilerOptions,
        );

        // 与扩展其他模块保持一致：若用户未配置 paths/baseUrl，兜底支持 @ -> src。
        if (!resolvedFileName && moduleName.startsWith("@/")) {
          for (const projectRoot of getProjectRoots(containingFile)) {
            resolvedFileName = tryResolveVueFile(
              path.resolve(projectRoot, "src", moduleName.slice(2)),
            );
            if (resolvedFileName) break;
          }
        }
      }

      if (!resolvedFileName) return undefined;

      return {
        resolvedFileName,
        extension: ts.Extension.Js,
        isExternalLibraryImport: false,
      } as ts.ResolvedModuleFull;
    }

    const VUE_RESOLUTION_CACHE_MAX = 500;
    const vueResolutionCache = new Map<string, ts.ResolvedModuleFull>();

    function getVueResolutionCacheKey(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
    ): string {
      return JSON.stringify({
        moduleName,
        containingFile: normalizePath(containingFile),
        baseUrl: compilerOptions.baseUrl ?? "",
        paths: compilerOptions.paths ?? {},
      });
    }

    function getCachedVueResolution(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
    ): ts.ResolvedModuleFull | undefined {
      const key = getVueResolutionCacheKey(
        moduleName,
        containingFile,
        compilerOptions,
      );
      const cached = vueResolutionCache.get(key);
      if (!cached) return undefined;
      if (!fileExists(cached.resolvedFileName)) {
        vueResolutionCache.delete(key);
        return undefined;
      }
      vueResolutionCache.delete(key);
      vueResolutionCache.set(key, cached);
      return cached;
    }

    function setCachedVueResolution(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
      resolved: ts.ResolvedModuleFull,
    ): void {
      const key = getVueResolutionCacheKey(
        moduleName,
        containingFile,
        compilerOptions,
      );
      vueResolutionCache.delete(key);
      vueResolutionCache.set(key, resolved);
      while (vueResolutionCache.size > VUE_RESOLUTION_CACHE_MAX) {
        const oldest = vueResolutionCache.keys().next().value;
        if (oldest === undefined) break;
        vueResolutionCache.delete(oldest);
      }
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

      // Inject // @ts-check into padded region so tsserver checks only .vue files
      // (global checkJs is false). The padded area is all spaces, so overwriting
      // the first 13 chars preserves total length and offset mapping.
      const TS_CHECK = "// @ts-check\n";
      if (scriptBodyStart >= TS_CHECK.length) {
        originalContent = TS_CHECK + originalContent.slice(TS_CHECK.length);
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
        checkJs: false,
        noImplicitThis: true,
        noImplicitAny: false,
        strictNullChecks: false,
        strictFunctionTypes: false,
        strictPropertyInitialization: false,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
      };
    };

    function resolveVueAwareModule(
      moduleName: string,
      containingFile: string,
      compilerOptions: ts.CompilerOptions,
      originalResolved?: ts.ResolvedModule | undefined,
    ): ts.ResolvedModule | undefined {
      if (originalResolved) return originalResolved;

      // 命中过去已解析的 .vue 结果，直接短路，避免重复触发
      // ts.resolveModuleName 的多轮磁盘探测。
      const cachedResolved = getCachedVueResolution(
        moduleName,
        containingFile,
        compilerOptions,
      );
      if (cachedResolved) return cachedResolved;

      try {
        const { resolvedModule } = ts.resolveModuleName(
          moduleName,
          containingFile,
          compilerOptions,
          host as ts.ModuleResolutionHost,
        );
        if (resolvedModule) return resolvedModule;
      } catch {}

      // 手动解析 .vue 目标：TS 原生 resolver 不识别 .vue 扩展，
      // 这里补上 paths/baseUrl/@ 别名与 index.vue 探测。
      const manualResolved = tryResolveVueModuleManually(
        moduleName,
        containingFile,
        compilerOptions,
      );
      if (manualResolved) {
        setCachedVueResolution(
          moduleName,
          containingFile,
          compilerOptions,
          manualResolved,
        );
        return manualResolved;
      }

      logResolutionMiss(moduleName, containingFile, compilerOptions);
      return undefined;
    }

    // ✅ 同时兼容 resolveModuleNames 与 resolveModuleNameLiterals。
    // TypeScript 5.x 在很多路径上会优先走后者；只包前者会导致线上 tsserver
    // 与本地 stub 行为不一致。
    const origResolveModuleNames = host.resolveModuleNames?.bind(host);
    host.resolveModuleNames = (
      moduleNames: string[],
      containingFile: string,
      reusedNames: string[] | undefined,
      redirectedReference: ts.ResolvedProjectReference | undefined,
      compilerOptions: ts.CompilerOptions,
      containingSourceFile?: ts.SourceFile,
    ): (ts.ResolvedModule | undefined)[] => {
      let origResults: (ts.ResolvedModule | undefined)[] | undefined;
      if (origResolveModuleNames) {
        try {
          origResults = origResolveModuleNames(
            moduleNames,
            containingFile,
            reusedNames,
            redirectedReference,
            compilerOptions,
            containingSourceFile,
          );
        } catch {}
      }
      return moduleNames.map((moduleName, i) =>
        resolveVueAwareModule(
          moduleName,
          containingFile,
          compilerOptions,
          origResults?.[i],
        ),
      );
    };

    const origResolveModuleNameLiterals =
      host.resolveModuleNameLiterals?.bind(host);
    host.resolveModuleNameLiterals = (
      moduleLiterals: readonly ts.StringLiteralLike[],
      containingFile: string,
      redirectedReference: ts.ResolvedProjectReference | undefined,
      compilerOptions: ts.CompilerOptions,
      containingSourceFile: ts.SourceFile,
      reusedNames: readonly ts.StringLiteralLike[] | undefined,
    ): readonly ts.ResolvedModuleWithFailedLookupLocations[] => {
      let origResults:
        | readonly ts.ResolvedModuleWithFailedLookupLocations[]
        | undefined;
      if (origResolveModuleNameLiterals) {
        try {
          origResults = origResolveModuleNameLiterals(
            moduleLiterals,
            containingFile,
            redirectedReference,
            compilerOptions,
            containingSourceFile,
            reusedNames,
          );
        } catch {}
      }

      return moduleLiterals.map((moduleLiteral, i) => ({
        resolvedModule: resolveVueAwareModule(
          moduleLiteral.text,
          containingFile,
          compilerOptions,
          origResults?.[i]?.resolvedModule,
        ) as ts.ResolvedModuleFull | undefined,
      }));
    };

    const origGetScriptVersion = host.getScriptVersion.bind(host);
    const vueContentVersions = new Map<
      string,
      { contentHash: string; version: number }
    >();

    host.getScriptVersion = (fileName: string) => {
      if (isVueFile(fileName)) {
        const baseVersion = origGetScriptVersion(fileName);
        const snap = origGetScriptSnapshot(fileName);
        if (!snap) return `vue:${baseVersion}`;

        // 性能关键：getScriptVersion 可能被频繁调用。
        // 这里不要读取整个文件内容（会产生巨大字符串分配并拖慢/拖挂 tsserver），
        // 只取长度 + 头尾片段作为指纹（与之前 text.length + slice(0,100) + slice(-100) 的语义一致）。
        const len = snap.getLength();
        const headEnd = Math.min(100, len);
        const tailStart = Math.max(0, len - 100);
        const head = snap.getText(0, headEnd);
        const tail = snap.getText(tailStart, len);
        // 加入宿主原始版本号，优先避免“中间改动但头尾不变”导致的误判。
        const contentHash = baseVersion + "|" + len + ":" + head + tail;

        const prev = vueContentVersions.get(fileName);
        if (prev && prev.contentHash === contentHash) {
          // ⚠️ 必须加前缀：避免与宿主原始 version（通常是 "1"/"2"...）碰撞，
          // 否则在插件初始化较晚时可能复用到“未 padding 的旧快照”，导致 <template> 被当成 JS/TS 解析。
          return `vue:${prev.version}`;
        }

        const newVersion = prev ? prev.version + 1 : 1;
        vueContentVersions.set(fileName, { contentHash, version: newVersion });
        return `vue:${newVersion}`;
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

    function overlapsScript(
      start: number,
      length: number,
      ext: ExtractedScript,
    ): boolean {
      const end = start + Math.max(0, length);
      return end >= ext.scriptStart && start <= ext.scriptEnd;
    }

    function mapDiagnosticToVueScript(
      diagnostic: ts.Diagnostic,
      ext: ExtractedScript,
    ): ts.DiagnosticWithLocation | null {
      // 这些 diagnostics 来自 LanguageService，理论上都有 file/start/length；
      // 这里做兜底防御，避免破坏返回类型。
      if (!diagnostic.file || diagnostic.start === undefined) return null;

      const length = diagnostic.length ?? 0;

      // 如果做了 wrap，先过滤掉追加的 WRAP_FUNC_DECL 区域
      if (ext.wrapInfo && diagnostic.start >= ext.wrapInfo.declStart) {
        return null;
      }

      let mappedStart = diagnostic.start;
      let mappedLength = length;

      if (ext.wrapInfo) {
        const span = spanToOriginal(
          diagnostic.start,
          length,
          ext.wrapInfo,
          ext.originalContent.length,
        );
        mappedStart = span.start;
        mappedLength = span.length;
      }

      // 只保留落在 <script> 内容区域内的诊断（避免 <template>/<style> 被 TS 误报）
      if (!overlapsScript(mappedStart, mappedLength, ext)) {
        return null;
      }

      // 注意：diagnostic 可能不是普通对象，这里用 Object.assign 保留原字段
      return Object.assign({}, diagnostic, {
        start: mappedStart,
        length: mappedLength,
      }) as ts.DiagnosticWithLocation;
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

    // -- Document Highlights ------------------------------------------

    proxy.getDocumentHighlights = (
      fileName: string,
      position: number,
      filesToSearch: string[],
    ) => {
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        const { wrapInfo } = ext;

        const mapped = wrapInfo ? toModified(position, wrapInfo) : position;
        const result = ls.getDocumentHighlights(fileName, mapped, filesToSearch);

        if (!result || !wrapInfo) {
          return result;
        }

        return result
          .map((highlight) => {
            if (!isVueFile(highlight.fileName)) {
              return highlight;
            }

            const targetExt =
              highlight.fileName === fileName
                ? ext
                : getExtracted(highlight.fileName);

            if (!targetExt.wrapInfo) {
              return highlight;
            }

            const highlightSpans = highlight.highlightSpans
              .map((span) => {
                const orig = backSpan(span.textSpan.start, span.textSpan.length, targetExt);
                if (orig.length <= 0) return null;
                return {
                  ...span,
                  textSpan: { start: orig.start, length: orig.length },
                };
              })
              .filter((span): span is ts.HighlightSpan => Boolean(span));

            return {
              ...highlight,
              highlightSpans,
            };
          })
          .filter((highlight) => highlight.highlightSpans.length > 0);
      }

      return ls.getDocumentHighlights(fileName, position, filesToSearch);
    };

    // -- Diagnostics --------------------------------------------------

    proxy.getSemanticDiagnostics = (fileName: string) => {
      if (isNodeModulesFile(fileName)) return [];
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        if (ext.scriptStart === 0 && ext.scriptEnd === 0) return [];

        const all = ls.getSemanticDiagnostics(fileName);
        return all
          .map((d) => mapDiagnosticToVueScript(d, ext))
          .filter((d): d is ts.DiagnosticWithLocation => Boolean(d));
      }
      return ls.getSemanticDiagnostics(fileName);
    };

    proxy.getSyntacticDiagnostics = (fileName: string) => {
      if (isNodeModulesFile(fileName)) return [];
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        if (ext.scriptStart === 0 && ext.scriptEnd === 0) return [];

        const all = ls.getSyntacticDiagnostics(fileName);
        return all
          .map((d) => mapDiagnosticToVueScript(d, ext))
          .filter((d): d is ts.DiagnosticWithLocation => Boolean(d));
      }
      return ls.getSyntacticDiagnostics(fileName);
    };

    proxy.getSuggestionDiagnostics = (fileName: string) => {
      if (isNodeModulesFile(fileName)) return [];
      if (isVueFile(fileName)) {
        const ext = getExtracted(fileName);
        if (ext.scriptStart === 0 && ext.scriptEnd === 0) return [];

        const all = ls.getSuggestionDiagnostics(fileName);
        return all
          .map((d) => mapDiagnosticToVueScript(d, ext))
          .filter((d): d is ts.DiagnosticWithLocation => Boolean(d));
      }
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

    // -- Code Fix / Refactor ------------------------------------------
    //
    // TypeScript 5.9 对我们这种“padding + wrap”的虚拟 JS 视图在 code fix/refactor
    // 路径上并不稳定，继续放行会直接把 semantic tsserver 打崩。
    // 这里先对 .vue 做保守降级：保留诊断、跳转、补全，关闭易崩的自动修复/重构。

    proxy.getCodeFixesAtPosition = (
      fileName: string,
      start: number,
      end: number,
      errorCodes: readonly number[],
      formatOptions: ts.FormatCodeSettings,
      preferences: ts.UserPreferences,
    ) => {
      if (isVueFile(fileName)) return [];
      return ls.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        errorCodes,
        formatOptions,
        preferences,
      );
    };

    proxy.getCombinedCodeFix = (
      scope: ts.CombinedCodeFixScope,
      fixId: {},
      formatOptions: ts.FormatCodeSettings,
      preferences: ts.UserPreferences,
    ) => {
      if ("fileName" in scope && isVueFile(scope.fileName)) {
        return { changes: [], commands: undefined };
      }
      return ls.getCombinedCodeFix(scope, fixId, formatOptions, preferences);
    };

    proxy.getApplicableRefactors = (
      fileName: string,
      positionOrRange: number | ts.TextRange,
      preferences: ts.UserPreferences | undefined,
      triggerReason?: ts.RefactorTriggerReason,
      kind?: string,
      includeInteractiveActions?: boolean,
    ) => {
      if (isVueFile(fileName)) return [];
      return ls.getApplicableRefactors(
        fileName,
        positionOrRange,
        preferences,
        triggerReason,
        kind,
        includeInteractiveActions,
      );
    };

    proxy.getEditsForRefactor = (
      fileName: string,
      formatOptions: ts.FormatCodeSettings,
      positionOrRange: number | ts.TextRange,
      refactorName: string,
      actionName: string,
      preferences: ts.UserPreferences | undefined,
      interactiveRefactorArguments?: ts.InteractiveRefactorArguments,
    ) => {
      if (isVueFile(fileName)) return undefined;
      return ls.getEditsForRefactor(
        fileName,
        formatOptions,
        positionOrRange,
        refactorName,
        actionName,
        preferences,
        interactiveRefactorArguments,
      );
    };

    logger.info("[vue-ts-plugin] ready");
    return proxy;
  }

  function getExternalFiles(project: ts.server.Project): string[] {
    try {
      return project.getRootFiles().filter((f) => f.endsWith(".vue"));
    } catch {
      return [];
    }
  }

  return { create, getExternalFiles };
}

export = init;
