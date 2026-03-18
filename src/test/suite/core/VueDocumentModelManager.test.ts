import * as assert from "assert";
import * as vscode from "vscode";
import { TreeSitterParser, type VueOptionsIndex } from "../../../core/TreeSitterParser";
import { VueDocumentModelManager } from "../../../core/VueDocumentModelManager";

suite("VueDocumentModelManager", () => {
  test("should retry getVueOptionsIndex after transient failure", async () => {
    const parser = TreeSitterParser.getInstance();
    const manager = VueDocumentModelManager.getInstance();
    const document = await vscode.workspace.openTextDocument({
      language: "vue",
      content: `<template><div /></template><script>export default {};</script>`,
    });
    const model = manager.getDocumentModel(document);
    const originalGetVueOptionsIndex = parser.getVueOptionsIndex;

    const successIndex: VueOptionsIndex = {
      properties: [],
      entriesByPath: new Map(),
      childrenByPath: new Map(),
    };

    let calls = 0;
    (parser as any).getVueOptionsIndex = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("transient failure");
      }
      return successIndex;
    };

    try {
      await assert.rejects(model.getVueOptionsIndex(), /transient failure/);

      const index = await model.getVueOptionsIndex();
      assert.strictEqual(calls, 2);
      assert.strictEqual(index, successIndex);
    } finally {
      (parser as any).getVueOptionsIndex = originalGetVueOptionsIndex;
    }
  });

  test("should retry getVueOptionProperties after transient failure", async () => {
    const parser = TreeSitterParser.getInstance();
    const manager = VueDocumentModelManager.getInstance();
    const document = await vscode.workspace.openTextDocument({
      language: "vue",
      content: `<template><div /></template><script>export default {};</script>`,
    });
    const model = manager.getDocumentModel(document);
    const originalGetVueOptionsIndex = parser.getVueOptionsIndex;

    let calls = 0;
    (parser as any).getVueOptionsIndex = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("transient failure");
      }
      return {
        properties: [
          {
            path: "message",
            name: "message",
            source: "data",
            inferredType: "string",
            start: 0,
            end: 7,
          },
        ],
        entriesByPath: new Map(),
        childrenByPath: new Map(),
      } satisfies VueOptionsIndex;
    };

    try {
      await assert.rejects(model.getVueOptionProperties(), /transient failure/);

      const properties = await model.getVueOptionProperties();
      assert.strictEqual(calls, 2);
      assert.deepStrictEqual(properties, [
        {
          name: "message",
          source: "data",
          inferredType: "string",
        },
      ]);
    } finally {
      (parser as any).getVueOptionsIndex = originalGetVueOptionsIndex;
    }
  });
});
