import * as assert from "assert";
import * as vscode from "vscode";
import { closeAllEditors, testWorkspaceRoot } from "../../util";

const extensionId = "zjffun.dependency-dependent";
const fixtureDirName = "__provider_fixtures__";

function getItemLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

async function writeFixtureFile(name: string, content: string): Promise<vscode.Uri> {
  assert.ok(testWorkspaceRoot, "测试工作区未初始化");

  const fixtureRoot = vscode.Uri.joinPath(testWorkspaceRoot, "src", "vue", fixtureDirName);
  await vscode.workspace.fs.createDirectory(fixtureRoot);

  const fileUri = vscode.Uri.joinPath(fixtureRoot, name);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
  return fileUri;
}

async function readDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(uri);
  assert.strictEqual(document.languageId, "vue");
  return document;
}

async function getCompletionList(
  uri: vscode.Uri,
  position: vscode.Position,
  triggerCharacter?: string,
  itemResolveCount?: number,
): Promise<vscode.CompletionList> {
  const result = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    uri,
    position,
    triggerCharacter,
    itemResolveCount,
  );
  assert.ok(result, "未拿到补全结果");
  return result;
}

suite("Vue Provider Integration", () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, "扩展未找到");
    await extension?.activate();
  });

  setup(async () => {
    await closeAllEditors();
  });

  teardown(async () => {
    await closeAllEditors();
  });

  suiteTeardown(async () => {
    if (!testWorkspaceRoot) {
      return;
    }

    const fixtureRoot = vscode.Uri.joinPath(testWorkspaceRoot, "src", "vue", fixtureDirName);
    try {
      await vscode.workspace.fs.delete(fixtureRoot, { recursive: true, useTrash: false });
    } catch {
      // 忽略不存在的情况
    }
  });

  test("模板补全覆盖插值、事件和绑定上下文", async () => {
    const uri = await writeFixtureFile(
      "TemplateCompletionFixture.vue",
      `<template>
  <section>
    <button @click="han"></button>
    <WidgetCard :hero-title="mes"></WidgetCard>
    <div>{{ us }}</div>
  </section>
</template>
<script>
export default {
  data() {
    return {
      message: "hello",
      userName: "alice",
    };
  },
  computed: {
    upperName() {
      return this.userName.toUpperCase();
    },
  },
  methods: {
    handleSubmit() {},
  },
};
</script>`,
    );

    const document = await readDocument(uri);

    const eventMarker = `@click="han`;
    const bindMarker = `:hero-title="mes`;
    const mustacheMarker = "{{ us";
    const eventPosition = document.positionAt(document.getText().indexOf(eventMarker) + eventMarker.length);
    const bindPosition = document.positionAt(document.getText().indexOf(bindMarker) + bindMarker.length);
    const mustachePosition = document.positionAt(document.getText().indexOf(mustacheMarker) + mustacheMarker.length);

    const eventList = await getCompletionList(uri, eventPosition);
    const bindList = await getCompletionList(uri, bindPosition);
    const mustacheList = await getCompletionList(uri, mustachePosition);

    const eventLabels = eventList.items.map(getItemLabel);
    const bindLabels = bindList.items.map(getItemLabel);
    const mustacheLabels = mustacheList.items.map(getItemLabel);

    assert.ok(eventLabels.includes("handleSubmit"), "事件上下文缺少 methods 补全");
    assert.ok(!eventLabels.includes("message"), "事件上下文不应混入 data 补全");

    assert.ok(bindLabels.includes("message"), "绑定上下文缺少 data 补全");
    assert.ok(bindLabels.includes("upperName"), "绑定上下文缺少 computed 补全");

    assert.ok(mustacheLabels.includes("userName"), "插值上下文缺少 data 补全");
  });

  test("组件标签补全返回工作区组件并附带自动导入编辑", async () => {
    await writeFixtureFile(
      "AutoPanel.vue",
      `<template>
  <div>auto panel</div>
</template>
<script>
export default {};
</script>`,
    );

    const hostUri = await writeFixtureFile(
      "HostAutoImport.vue",
      `<template>
  <div>
    <AutoP></AutoP>
  </div>
</template>
<script>
export default {
  components: {},
};
</script>`,
    );

    const document = await readDocument(hostUri);
    const position = document.positionAt(document.getText().indexOf("<AutoP") + "<AutoP".length);
    const list = await getCompletionList(hostUri, position, "<", 20);
    const target = list.items.find((item) => getItemLabel(item) === "AutoPanel");

    assert.ok(target, "未返回 AutoPanel 组件标签补全");
    assert.ok(target?.additionalTextEdits?.length, "组件标签补全缺少自动导入编辑");

    const editTexts = (target?.additionalTextEdits ?? []).map((edit) => edit.newText);
    assert.ok(
      editTexts.some((text) => text.includes(`import AutoPanel from '@/vue/${fixtureDirName}/AutoPanel.vue';`)),
      "缺少组件 import 编辑",
    );
    assert.ok(
      editTexts.some((text) => text.includes("AutoPanel")),
      "缺少 components 注册编辑",
    );
  });

  test("组件 props 补全会跳过当前标签已存在的属性", async () => {
    await writeFixtureFile(
      "PropsChildBox.vue",
      `<template>
  <div>props child</div>
</template>
<script>
export default {
  props: {
    heroTitle: String,
    visible: Boolean,
  },
};
</script>`,
    );

    const hostUri = await writeFixtureFile(
      "PropsHost.vue",
      `<template>
  <div>
    <PropsChildBox :visible="visible" />
  </div>
</template>
<script>
import PropsChildBox from "./PropsChildBox.vue";

export default {
  components: {
    PropsChildBox,
  },
  data() {
    return {
      visible: true,
    };
  },
};
</script>`,
    );

    const document = await readDocument(hostUri);
    const marker = `:visible="visible" `;
    const position = document.positionAt(document.getText().indexOf(marker) + marker.length);
    const list = await getCompletionList(hostUri, position, " ");
    const labels = list.items.map(getItemLabel);

    assert.ok(labels.includes("heroTitle"), "缺少未使用 props 的补全");
    assert.ok(!labels.includes("visible"), "已存在 props 不应再次补全");
  });
});
