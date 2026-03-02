"use strict";

const fs = require("fs");
const path = require("path");

const candidates = [
  // 开发态：file: 依赖通常是软链到仓库根目录下的 ts-plugin-bridge
  path.resolve(__dirname, "../dist/ts-plugin.js"),
  // 打包态：若桥接包被复制到 node_modules/dependency-dependent-ts-plugin
  path.resolve(__dirname, "../../dist/ts-plugin.js"),
];

for (const p of candidates) {
  if (fs.existsSync(p)) {
    module.exports = require(p);
    return;
  }
}

throw new Error(
  `Cannot locate dist/ts-plugin.js. Tried: ${candidates.join(" | ")}`
);
