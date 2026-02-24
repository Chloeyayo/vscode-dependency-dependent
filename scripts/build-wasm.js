/**
 * 使用 tree-sitter-cli 本地编译 grammar WASM 文件
 *
 * 前置条件（二选一）：
 *   1. 安装 Emscripten SDK（推荐）：https://emscripten.org/docs/getting_started/downloads.html
 *   2. 安装 Docker
 *
 * 用法：
 *   node scripts/build-wasm.js
 *   node scripts/build-wasm.js --docker   # 强制使用 Docker
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WASM_DIR = path.join(__dirname, '../src/grammars');
const TEMP_DIR = path.join(os.tmpdir(), 'tree-sitter-build-wasm');

// tree-sitter-cli 0.20.8 生成 ABI 14 的 WASM，兼容 web-tree-sitter@0.26.5
const CLI_VERSION = '0.20.8';

// 需要编译的 grammar 及其 npm 包名/版本
const GRAMMARS = [
  {
    name: 'tree-sitter-javascript',
    pkg: 'tree-sitter-javascript@0.20.2',
    output: 'tree-sitter-javascript.wasm',
  },
  {
    name: 'tree-sitter-typescript',
    pkg: 'tree-sitter-typescript@0.20.5',
    // typescript grammar 的 parser 在 typescript 子目录
    subdir: 'typescript',
    output: 'tree-sitter-typescript.wasm',
  },
  {
    name: 'tree-sitter-tsx',
    pkg: 'tree-sitter-typescript@0.20.5',
    subdir: 'tsx',
    output: 'tree-sitter-tsx.wasm',
  },
  {
    name: 'tree-sitter-vue',
    pkg: path.join(__dirname, '../tree-sitter-vue-0.2.1.tgz'),
    output: 'tree-sitter-vue.wasm',
  },
];

const useDocker = process.argv.includes('--docker');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  ensureDir(WASM_DIR);
  ensureDir(TEMP_DIR);

  // 1. 在临时目录安装 tree-sitter-cli 和 grammar 包
  const pkgJson = path.join(TEMP_DIR, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, '{"private":true}');
  }

  console.log('\n=== 安装 tree-sitter-cli 和 grammar 包 ===\n');

  const uniquePkgs = [...new Set(GRAMMARS.map((g) => g.pkg))];
  const installList = [`tree-sitter-cli@${CLI_VERSION}`, ...uniquePkgs].join(' ');
  run(`npm install ${installList}`, { cwd: TEMP_DIR });

  const treeSitterBin = path.join(
    TEMP_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tree-sitter.cmd' : 'tree-sitter'
  );

  // 2. 逐个编译 grammar
  for (const grammar of GRAMMARS) {
    console.log(`\n=== 编译 ${grammar.output} ===\n`);

    // 确定 grammar 源码目录
    let grammarDir;
    const pkgName = grammar.pkg.startsWith('/') || grammar.pkg.startsWith('.')
      ? path.basename(grammar.pkg, '.tgz').replace(/-\d+\.\d+\.\d+$/, '')
      : grammar.pkg.split('@')[0];

    grammarDir = path.join(TEMP_DIR, 'node_modules', pkgName);

    if (grammar.subdir) {
      grammarDir = path.join(grammarDir, grammar.subdir);
    }

    if (!fs.existsSync(grammarDir)) {
      console.error(`Grammar 目录不存在: ${grammarDir}`);
      continue;
    }

    // 使用 tree-sitter build-wasm 编译
    const dockerFlag = useDocker ? '--docker' : '';
    try {
      run(`"${treeSitterBin}" build-wasm ${dockerFlag} "${grammarDir}"`);
    } catch (e) {
      console.error(`编译 ${grammar.output} 失败: ${e.message}`);
      console.error('请确保已安装 Emscripten SDK 或使用 --docker 参数');
      continue;
    }

    // tree-sitter build-wasm 会在当前目录生成 .wasm 文件
    const generatedName = grammar.subdir
      ? `tree-sitter-${grammar.subdir}.wasm`
      : `${pkgName}.wasm`;
    const generatedPath = path.join(process.cwd(), generatedName);

    if (fs.existsSync(generatedPath)) {
      const dest = path.join(WASM_DIR, grammar.output);
      fs.copyFileSync(generatedPath, dest);
      fs.unlinkSync(generatedPath);
      const size = fs.statSync(dest).size;
      console.log(`✓ ${grammar.output} (${(size / 1024).toFixed(1)} KB)`);
    } else {
      // 也可能生成在 grammarDir 下
      const altPath = path.join(grammarDir, generatedName);
      if (fs.existsSync(altPath)) {
        const dest = path.join(WASM_DIR, grammar.output);
        fs.copyFileSync(altPath, dest);
        fs.unlinkSync(altPath);
        const size = fs.statSync(dest).size;
        console.log(`✓ ${grammar.output} (${(size / 1024).toFixed(1)} KB)`);
      } else {
        console.error(`未找到生成的 WASM 文件: ${generatedName}`);
      }
    }
  }

  console.log('\n=== 完成 ===\n');
  console.log(`WASM 文件输出到: ${WASM_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
