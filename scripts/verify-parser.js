"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const path = require('path');
// Mock vscode module
const mockVscode = {
    window: {
        createOutputChannel: () => ({ appendLine: console.log })
    },
    Uri: {
        file: (f) => ({ fsPath: f })
    }
};
// Hack to mock 'vscode' import for the TS file if running via ts-node
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'vscode') {
        return mockVscode;
    }
    return originalRequire.apply(this, arguments);
};
// We need to run this with ts-node or compile it. 
// For simplicity, let's assume we can use ts-node via npx.
const { TreeSitterParser } = require('../src/core/TreeSitterParser');
function test() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("Initializing parser...");
        // Force the instance to use the correct path relative to this script
        // scripts/../src/grammars
        const grammarPath = path.join(__dirname, '../src/grammars');
        // We might need to access the private constructor or use getInstance with path if we allowed it.
        // TreeSitterParser.getInstance() uses __dirname relative to the *source* file. 
        // If running via ts-node, __dirname might be different.
        const parser = TreeSitterParser.getInstance();
        yield parser.init();
        const jsContent = `
        import { foo } from 'bar';
        const baz = require('baz');
    `;
        console.log("Testing JS extraction...");
        const jsImports = yield parser.extractImports(jsContent, 'test.js');
        console.log('JS Imports:', jsImports);
        const tsContent = `
        import { Type } from 'pkg';
        import * as All from 'all';
    `;
        console.log("Testing TS extraction...");
        const tsImports = yield parser.extractImports(tsContent, 'test.ts');
        console.log('TS Imports:', tsImports);
        const vueContent = `
<template>
  <div></div>
</template>
<script>
import Foo from './Foo.vue';
export default {
    components: { Foo }
}
</script>
    `;
        console.log("Testing Vue extraction...");
        const vueImports = yield parser.extractImports(vueContent, 'test.vue');
        console.log('Vue Imports:', vueImports);
    });
}
test().catch(console.error);
//# sourceMappingURL=verify-parser.js.map