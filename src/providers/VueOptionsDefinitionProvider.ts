import * as vscode from "vscode";
import { VuePrototypeScanner } from "../core/VuePrototypeScanner";
import { VueDocumentModelManager } from "../core/VueDocumentModelManager";

/**
 * Vue2 Options API Definition Provider
 * Enables Ctrl+Click navigation for:
 * - this.xxx -> data / methods / computed / props / watch
 * - this.obj.xxx -> nested object properties indexed from data/computed literals
 * - this.$xxx -> Vue.prototype assignments / plugin imports in entry files
 */
export class VueOptionsDefinitionProvider implements vscode.DefinitionProvider {
  private documentModels: VueDocumentModelManager;
  private prototypeScanner: VuePrototypeScanner;

  constructor(prototypeScanner?: VuePrototypeScanner) {
    this.documentModels = VueDocumentModelManager.getInstance();
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

    const model = this.documentModels.getDocumentModel(document);

    // Otherwise: try component property definition from the shared VueOptionsIndex
    try {
      const chain = this.getThisPropertyChain(document, wordRange, targetWord);
      const index = await model.getVueOptionsIndex();
      const pathKey = chain.length > 0 ? chain.join(".") : targetWord;
      const result = index.entriesByPath.get(pathKey) || index.entriesByPath.get(targetWord);

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

  private getThisPropertyChain(
    document: vscode.TextDocument,
    wordRange: vscode.Range,
    targetWord: string,
  ): string[] {
    const lineText = document.lineAt(wordRange.end.line).text;
    const beforeWordEnd = lineText.substring(0, wordRange.end.character);
    const match = beforeWordEnd.match(/\bthis\.([\$\w]+(?:\.[\$\w]+)*)$/);
    if (!match) return [];

    const chain = match[1].split('.');
    if (chain[chain.length - 1] !== targetWord) {
      return [];
    }

    return chain;
  }
}
