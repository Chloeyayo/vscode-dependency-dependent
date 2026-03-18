import * as vscode from "vscode";
import { type VueOptionsIndex } from "../core/TreeSitterParser";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";

/**
 * Hover provider for Vue 2 Options API `this.xxx` members.
 * Shows inferred types from data / computed / props / methods / watch.
 */
export class VueOptionsHoverProvider implements vscode.HoverProvider {
  private documentModels: VueDocumentModelManager;

  constructor() {
    this.documentModels = VueDocumentModelManager.getInstance();
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    if (!document.fileName.endsWith(".vue")) return null;
    const model = this.documentModels.getDocumentModel(document);

    // For <script lang="ts"> files, tsserver handles this.xxx hover natively
    // via ThisType wrapping in the TS plugin. Skip to avoid duplicate hovers.
    if (/<script[^>]*\blang\s*=\s*["']?(ts|typescript)["']?/i.test(model.text)) {
      return null;
    }

    const lineText = document.lineAt(position.line).text;
    const col = position.character;

    // Find `this.xxx` or `this.xxx.yyy.zzz` that the cursor is on
    const re = /\bthis\.([$\w]+(?:\.[$\w]+)*)/g;
    let match;
    while ((match = re.exec(lineText)) !== null) {
      const memberStart = match.index + 5; // after "this."
      const memberEnd = match.index + match[0].length;
      if (col < memberStart || col > memberEnd) continue;

      // Cursor is on this member expression
      const fullChain = match[1].split("."); // e.g. ['obj', 'a']

      // Determine which segment the cursor is on
      let offset = memberStart;
      let segmentIndex = 0;
      for (let i = 0; i < fullChain.length; i++) {
        const segStart = offset;
        const segEnd = offset + fullChain[i].length;
        if (col >= segStart && col <= segEnd) {
          segmentIndex = i;
          break;
        }
        offset = segEnd + 1; // skip the dot
      }

      const index = await model.getVueOptionsIndex();

      if (segmentIndex === 0) {
        // Hovering on the first property: this.[xxx]
        return this.hoverTopLevel(index, fullChain[0], position, match);
      } else {
        // Hovering on a nested property: this.obj.[yyy]
        const parentChain = fullChain.slice(0, segmentIndex);
        const targetProp = fullChain[segmentIndex];
        return this.hoverNested(index, parentChain, targetProp, position, match, segmentIndex);
      }
    }

    return null;
  }

  private async hoverTopLevel(
    index: VueOptionsIndex,
    propName: string,
    position: vscode.Position,
    match: RegExpExecArray
  ): Promise<vscode.Hover | null> {
    const prop = index.entriesByPath.get(propName);
    if (!prop) return null;

    const typeStr = prop.inferredType || "any";
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`(${prop.source}) ${propName}: ${typeStr}`, "typescript");

    const memberStart = match.index + 5;
    const range = new vscode.Range(
      position.line, memberStart,
      position.line, memberStart + propName.length
    );
    return new vscode.Hover(md, range);
  }

  private async hoverNested(
    index: VueOptionsIndex,
    parentChain: string[],
    targetProp: string,
    position: vscode.Position,
    match: RegExpExecArray,
    segmentIndex: number
  ): Promise<vscode.Hover | null> {
    const nestedProps = index.childrenByPath.get(parentChain.join(".")) || [];
    const prop = nestedProps.find(p => p.name === targetProp);
    if (!prop) return null;

    const typeStr = prop.inferredType || "any";
    const chainStr = parentChain.join(".");
    const md = new vscode.MarkdownString();
    md.appendCodeblock(`(${chainStr}) ${targetProp}: ${typeStr}`, "typescript");

    // Calculate range for the hovered segment
    let offset = match.index + 5; // after "this."
    for (let i = 0; i < segmentIndex; i++) {
      offset += parentChain[i].length + 1; // prop + dot
    }
    const range = new vscode.Range(
      position.line, offset,
      position.line, offset + targetProp.length
    );
    return new vscode.Hover(md, range);
  }
}
