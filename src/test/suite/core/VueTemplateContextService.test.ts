import * as assert from "assert";
import { VueTemplateContextService } from "../../../core/VueTemplateContextService";
import { getRootTemplateBounds } from "../../../core/vueTemplateUtils";

suite("VueTemplateContextService", () => {
  const service = VueTemplateContextService.getInstance();

  test("should detect mustache completion context inside root template", () => {
    const content = `<template>
  <div>{{ userName }}</div>
</template>
<script>
export default {};
</script>`;
    const bounds = getRootTemplateBounds(content);
    const offset = content.indexOf("userName") + 2;

    const ctx = service.detectCompletionContext(
      content,
      offset,
      "{{ us",
      bounds,
    );

    assert.deepStrictEqual(ctx, { type: "mustache" });
  });

  test("should detect directive value completion contexts", () => {
    const content = `<template>
  <Comp @click="han" :title="msg" />
</template>`;
    const bounds = getRootTemplateBounds(content);
    const eventOffset = content.indexOf('han') + 2;
    const bindOffset = content.indexOf('msg') + 2;

    const eventCtx = service.detectCompletionContext(
      content,
      eventOffset,
      '  <Comp @click="han',
      bounds,
    );
    const bindCtx = service.detectCompletionContext(
      content,
      bindOffset,
      '  <Comp @click="han" :title="msg',
      bounds,
    );

    assert.deepStrictEqual(eventCtx, { type: "event" });
    assert.deepStrictEqual(bindCtx, { type: "bind" });
  });

  test("should resolve open tag context and existing attributes", () => {
    const content = `<template>
  <MyDialog :title="msg" @close="handleClose" visible />
</template>`;
    const bounds = getRootTemplateBounds(content);
    const offset = content.indexOf("handleClose") + "handleClose".length;
    const tailOffset = content.indexOf("/>");

    const tagCtx = service.getOpenTagContext(content, offset, bounds);
    const tailTagCtx = service.getOpenTagContext(content, tailOffset, bounds);

    assert.ok(tagCtx, "应识别到当前开标签");
    assert.strictEqual(tagCtx?.tagName, "MyDialog");
    assert.deepStrictEqual(
      Array.from(tagCtx?.existingAttributes ?? []).sort(),
      ["close", "title"],
    );
    assert.deepStrictEqual(
      Array.from(tailTagCtx?.existingAttributes ?? []).sort(),
      ["close", "title", "visible"],
    );
  });

  test("should detect tag name completion context", () => {
    const ctx = service.getTagNameCompletionContext("  <my-di", 8);

    assert.deepStrictEqual(ctx, {
      partialName: "my-di",
      replaceStartCharacter: 3,
    });
  });

  test("should resolve current multiline open tag without falling back to previous siblings", () => {
    const content = `<template>
  <PrevCard />
  <MyDialog
    :title="msg"
    @close="handleClose"
    visible
  />
</template>`;
    const bounds = getRootTemplateBounds(content);
    const offset = content.indexOf("visible") + "visible".length;

    const tagCtx = service.getOpenTagContext(content, offset, bounds);

    assert.ok(tagCtx, "应识别到多行开标签");
    assert.strictEqual(tagCtx?.tagName, "MyDialog");
    assert.deepStrictEqual(
      Array.from(tagCtx?.existingAttributes ?? []).sort(),
      ["close", "title", "visible"],
    );
  });
});
