import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension", () => {
  const extensionID = "zjffun.dependency-dependent";
  const extensionShortName = "dependency-dependent";

  let extension: vscode.Extension<any> | undefined;

  extension = vscode.extensions.getExtension(extensionID);

  setup(async () => {});

  teardown(async () => {});

  test("All package.json commands should be registered in extension", async () => {
    if (!extension) {
      throw Error("can't find extension");
    }
    await extension.activate();

    const packageCommands = extension.packageJSON.contributes.commands.map(
      (c: any) => c.command
    );

    // package.json 中声明的命令都必须注册成功
    const allCommands = await vscode.commands.getCommands(true);
    packageCommands.forEach((command: string) => {
      const result = allCommands.some((c) => c === command);
      assert.ok(result, `Command is not registered: ${command}`);
    });
  });
});
