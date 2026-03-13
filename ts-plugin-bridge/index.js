"use strict";

const fs = require("fs");
const path = require("path");

// 解析符号链接，拿到真实物理路径（解决 pnpm 符号链接问题）
let realDir;
try {
  realDir = path.dirname(fs.realpathSync(__filename));
} catch (_) {
  realDir = __dirname;
}

const candidates = [
  // 真实路径：pnpm 符号链接解析后 → ts-plugin-bridge/../dist/ts-plugin.js
  path.resolve(realDir, "../dist/ts-plugin.js"),
  // 开发态：file: 依赖（__dirname 未被符号链接时）
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
