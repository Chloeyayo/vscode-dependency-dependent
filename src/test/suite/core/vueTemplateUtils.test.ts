import * as assert from "assert";
import {
  getRootTemplateBounds,
  isOffsetInsideRootTemplate,
} from "../../../core/vueTemplateUtils";

suite("vueTemplateUtils", () => {
  test("should detect root template bounds", () => {
    const content = `<template>
  <div>{{ msg }}</div>
</template>
<script>
export default {}
</script>`;

    const bounds = getRootTemplateBounds(content);
    assert.ok(bounds, "root template bounds should exist");
    assert.ok(bounds!.openTagEnd < bounds!.closeTagStart);
  });

  test("should return true only for offsets inside root template", () => {
    const content = `<template>
  <div>{{ msg }}</div>
</template>
<script>
const x = 1;
</script>`;

    const templateOffset = content.indexOf("msg");
    const scriptOffset = content.indexOf("x = 1");
    assert.equal(isOffsetInsideRootTemplate(content, templateOffset), true);
    assert.equal(isOffsetInsideRootTemplate(content, scriptOffset), false);
  });

  test("should return null/false when root template is missing", () => {
    const content = `<script>
export default {}
</script>`;

    assert.equal(getRootTemplateBounds(content), null);
    assert.equal(isOffsetInsideRootTemplate(content, 5), false);
  });
});
