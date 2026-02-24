import * as vscode from "vscode";
import { TreeSitterParser } from "../core/TreeSitterParser";

/**
 * Vue2 Options API Definition Provider
 * Enables Ctrl+Click navigation for:
 * - this.xxx -> data properties
 * - this.xxx -> methods
 * - this.xxx -> computed properties
 * - this.xxx -> props
 */
export class VueOptionsDefinitionProvider implements vscode.DefinitionProvider {
  private treeSitterParser: TreeSitterParser;

  constructor() {
    this.treeSitterParser = TreeSitterParser.getInstance();
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | null> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;

    const targetWord = document.getText(wordRange);
    const fileContent = document.getText();

    try {
      const result = await this.treeSitterParser.findVueOptionDefinition(fileContent, targetWord);

      if (result) {
        const startPos = document.positionAt(result.start);
        const endPos = document.positionAt(result.end);
        return new vscode.Location(document.uri, new vscode.Range(startPos, endPos));
      }
    } catch (e) {
      // Silent fail on parse errors
      console.error("VueOptionsDefinitionProvider TreeSitter Parse Error:", e);
    }

    return null;
  }
}
