import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript/lib/tsserverlibrary";
import init = require("../../../ts-plugin/index");

suite("VueTsPlugin", () => {
  test("should inject Vue instance members into wrapped vue snapshot", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dd-vue-ts-plugin-"));
    const srcDir = path.join(tmpRoot, "src");
    const settingsDir = path.join(tmpRoot, ".vscode");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(settingsDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({
        dependencies: {
          "vue-router": "^3.0.0",
          vuex: "^3.0.0",
          "element-ui": "^2.0.0",
        },
      }, null, 2));
      fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
        "dependencyDependent.vue.customDollarProperties": ["$customFromSettings"],
      }, null, 2));
      fs.writeFileSync(path.join(srcDir, "main.js"), "Vue.prototype.$API = {};\n");

      const vueFile = path.join(srcDir, "Comp.vue");
      const vueContent = `<template><div /></template>
<script>
export default {
  methods: {
    test() {
      this.$router;
    },
  },
};
</script>`;
      fs.writeFileSync(vueFile, vueContent);

      const files = new Map([[vueFile, vueContent]]);
      const versions = new Map([[vueFile, "1"]]);
      const compilerOptions: ts.CompilerOptions = {
        allowJs: true,
        checkJs: true,
        noEmit: true,
      };

      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => [vueFile],
        getScriptVersion: (fileName) => versions.get(fileName) || "1",
        getScriptSnapshot: (fileName) => {
          const text = files.get(fileName)
            ?? (fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf8") : undefined);
          return text == null ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getScriptKind: (fileName) => fileName.endsWith(".vue")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.Unknown,
        getCurrentDirectory: () => tmpRoot,
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: fs.existsSync,
        readFile: (fileName) => fs.readFileSync(fileName, "utf8"),
        readDirectory: ts.sys.readDirectory,
        directoryExists: (dirName) => fs.existsSync(dirName) && fs.statSync(dirName).isDirectory(),
        getDirectories: ts.sys.getDirectories,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
      };

      const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
      const plugin = init({ typescript: ts });
      plugin.create({
        languageService,
        languageServiceHost: host,
        config: {},
        project: {
          getProjectName: () => path.join(tmpRoot, "tsconfig.json"),
          getCurrentDirectory: () => tmpRoot,
          projectService: {
            logger: {
              info: () => {},
            },
          },
        } as any,
      } as ts.server.PluginCreateInfo);

      const snapshot = host.getScriptSnapshot?.(vueFile);
      assert.ok(snapshot, "插件应返回改写后的 vue 快照");
      const text = snapshot.getText(0, snapshot.getLength());

      for (const member of [
        "$router",
        "$route",
        "$store",
        "$message",
        "$API",
        "$refs",
        "$set",
        "$customFromSettings",
      ]) {
        assert.ok(text.includes(member), `快照中应包含 ${member} 的 this 类型声明`);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("should resolve aliased js modules via @ -> src fallback", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dd-vue-ts-plugin-"));
    const srcDir = path.join(tmpRoot, "src");
    const apiDir = path.join(srcDir, "api");
    fs.mkdirSync(apiDir, { recursive: true });

    try {
      const vueFile = path.join(srcDir, "Table.vue");
      const apiFile = path.join(apiDir, "table.js");
      const vueContent = `<script>
import { getList } from "@/api/table";

export default {
  methods: {
    test() {
      return getList();
    },
  },
};
</script>`;
      fs.writeFileSync(vueFile, vueContent);
      fs.writeFileSync(apiFile, "export function getList() { return []; }\n");

      const files = new Map([[vueFile, vueContent]]);
      const versions = new Map([[vueFile, "1"]]);
      const compilerOptions: ts.CompilerOptions = {
        allowJs: true,
        checkJs: true,
        noEmit: true,
      };

      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => [vueFile],
        getScriptVersion: (fileName) => versions.get(fileName) || "1",
        getScriptSnapshot: (fileName) => {
          const text = files.get(fileName)
            ?? (fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf8") : undefined);
          return text == null ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getScriptKind: (fileName) => fileName.endsWith(".vue")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.Unknown,
        getCurrentDirectory: () => tmpRoot,
        getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
        fileExists: fs.existsSync,
        readFile: (fileName) => fs.readFileSync(fileName, "utf8"),
        readDirectory: ts.sys.readDirectory,
        directoryExists: (dirName) => fs.existsSync(dirName) && fs.statSync(dirName).isDirectory(),
        getDirectories: ts.sys.getDirectories,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
      };

      const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
      const plugin = init({ typescript: ts });
      plugin.create({
        languageService,
        languageServiceHost: host,
        config: {},
        project: {
          getProjectName: () => path.join(tmpRoot, "tsconfig.json"),
          getCurrentDirectory: () => tmpRoot,
          projectService: {
            logger: {
              info: () => {},
            },
          },
        } as any,
      } as ts.server.PluginCreateInfo);

      const compilerOpts = host.getCompilationSettings();
      const resolved = host.resolveModuleNames?.(
        ["@/api/table"],
        vueFile,
        undefined,
        undefined,
        compilerOpts,
      ) as (ts.ResolvedModuleFull | undefined)[] | undefined;

      assert.ok(resolved, "插件应接管模块解析");
      assert.strictEqual(resolved?.[0]?.resolvedFileName, apiFile);
      assert.strictEqual(resolved?.[0]?.extension, ts.Extension.Js);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
