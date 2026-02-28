import * as vscode from "vscode";
import { TreeSitterParser } from "../core/TreeSitterParser";
import { VuePrototypeScanner } from "../core/VuePrototypeScanner";

/**
 * Vue2 Options API Definition Provider
 * Enables Ctrl+Click navigation for:
 * - this.xxx -> data / methods / computed / props
 * - this.$xxx -> Vue.prototype assignments / plugin imports in entry files
 */
export class VueOptionsDefinitionProvider implements vscode.DefinitionProvider {
  private treeSitterParser: TreeSitterParser;
  private prototypeScanner: VuePrototypeScanner;

  constructor(prototypeScanner?: VuePrototypeScanner) {
    this.treeSitterParser = TreeSitterParser.getInstance();
    this.prototypeScanner = prototypeScanner ?? new VuePrototypeScanner();
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | null> {
    // Get the word under cursor (include $ prefix)
    const wordRange = document.getWordRangeAtPosition(position, /\$?\w+/);
    if (!wordRange) return null;

    const targetWord = document.getText(wordRange);

    // Check if this is a `this.$xxx` pattern
    if (targetWord.startsWith('$')) {
      // Verify it's preceded by "this."
      const lineText = document.lineAt(position.line).text;
      const beforeWord = lineText.substring(0, wordRange.start.character);
      if (/\bthis\.\s*$/.test(beforeWord)) {
        return this.findDollarDefinition(targetWord, document);
      }
    }

    if (token.isCancellationRequested) return null;

    // Otherwise: try component property definition (data/methods/computed/props)
    const fileContent = document.getText();
    try {
      const result = await this.treeSitterParser.findVueOptionDefinition(fileContent, targetWord);

      if (result) {
        const startPos = document.positionAt(result.start);
        const endPos = document.positionAt(result.end);
        return new vscode.Location(document.uri, new vscode.Range(startPos, endPos));
      }
    } catch (e) {
      console.error("VueOptionsDefinitionProvider TreeSitter Parse Error:", e);
    }

    return null;
  }

  /**
   * Find the definition of a $xxx property in entry files.
   */
  private async findDollarDefinition(
    propertyName: string,
    document: vscode.TextDocument
  ): Promise<vscode.Location | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) return null;

    try {
      return await this.prototypeScanner.findDefinition(propertyName, workspaceFolder);
    } catch (e) {
      console.error("VueOptionsDefinitionProvider $xxx lookup error:", e);
      return null;
    }
  }
}
