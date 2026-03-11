import * as vscode from "vscode";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { getRootTemplateBounds } from "../core/vueTemplateUtils";

function normalizeComponentName(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

export default async function jumpToTemplateComponentTag() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  if (document.languageId !== "vue" && !document.fileName.endsWith(".vue")) {
    vscode.window.showInformationMessage("请在 .vue 文件中使用该命令。");
    return;
  }

  const text = document.getText();
  const offset = document.offsetAt(editor.selection.active);

  const parser = TreeSitterParser.getInstance();
  let importInfo:
    | { preferredLocalName: string | null; localNames: string[] }
    | null = null;
  try {
    importInfo = await parser.getImportLocalNamesAtPosition(
      text,
      document.uri.fsPath,
      offset
    );
  } catch (e) {
    vscode.window.showErrorMessage(`解析 import 语句失败：${e}`);
    return;
  }

  if (!importInfo) {
    vscode.window.showInformationMessage(
      "请把光标放在 import 语句上（例如：import MyCom from 'xxx'）。"
    );
    return;
  }

  let componentName =
    importInfo.preferredLocalName ||
    (importInfo.localNames.length === 1 ? importInfo.localNames[0] : undefined);

  if (!componentName) {
    const picked = await vscode.window.showQuickPick(
      importInfo.localNames.map((n) => ({ label: n })),
      {
        placeHolder: "选择要在模板中定位的导入标识符",
        canPickMany: false,
      }
    );
    if (!picked) return;
    componentName = picked.label;
  }

  const bounds = getRootTemplateBounds(text);
  if (!bounds) {
    vscode.window.showInformationMessage("未找到根级 <template>，无法跳转。");
    return;
  }

  const templateStart = bounds.openTagEnd + 1;
  const templateEnd = bounds.closeTagStart;
  const templateText = text.slice(templateStart, templateEnd);

  const target = normalizeComponentName(componentName);
  const tagRe = /<\s*(?!\/|!|\?)([A-Za-z][\w-]*)/g;

  const matches: { tagName: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(templateText)) !== null) {
    const tagName = m[1];
    if (normalizeComponentName(tagName) !== target) continue;

    const tagNameOffsetInMatch = m[0].indexOf(tagName);
    const start =
      templateStart +
      m.index +
      (tagNameOffsetInMatch >= 0 ? tagNameOffsetInMatch : 1);
    matches.push({ tagName, start, end: start + tagName.length });
  }

  if (matches.length === 0) {
    vscode.window.showInformationMessage(
      `在 <template> 中未找到组件 ${componentName} 的使用（例如 <my-com />）。`
    );
    return;
  }

  let targetMatch = matches[0];
  if (matches.length > 1) {
    type PickItem = vscode.QuickPickItem & {
      match: { tagName: string; start: number; end: number };
    };

    const items: PickItem[] = matches.map((match) => {
      const pos = document.positionAt(match.start);
      const lineText = document.lineAt(pos.line).text.trim();
      return {
        label: `<${match.tagName}>`,
        description: `第 ${pos.line + 1} 行`,
        detail: lineText,
        match,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `找到 ${matches.length} 处使用，选择要跳转的位置`,
      matchOnDescription: true,
      matchOnDetail: true,
      canPickMany: false,
    });

    if (!picked) return;
    targetMatch = picked.match;
  }

  const range = new vscode.Range(
    document.positionAt(targetMatch.start),
    document.positionAt(targetMatch.end)
  );
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

