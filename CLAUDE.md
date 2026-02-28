# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension ("Dependency & Dependent") that analyzes and visualizes file dependencies/dependents in a tree view. Focused on Vue 2 projects with webpack alias support. Published as `dependency-dependent` on the VS Code Marketplace.

**This extension is designed to REPLACE Volar and Vetur.** It provides its own Vue language intelligence (completions, definitions, formatting) without depending on those extensions. Users will NOT have Volar/Vetur installed — all Vue language features (JS/TS completions in `<script>`, template completions, formatting, go-to-definition) must be self-contained in this extension.

## Build & Development Commands

```bash
yarn install                    # Install dependencies
npm run esbuild                 # Development build (outputs to dist/)
npm run esbuild-watch           # Watch mode with auto-rebuild
npm run vscode:prepublish       # Production build (minified)
npm run test-compile && npm run test  # Compile and run tests
npm run deploy                  # Publish to VS Code Marketplace
```

Debug with F5 in VS Code — launches extension in a new Extension Development Host window. Tests run via `@vscode/test-electron` with Mocha against the `test-project/` fixture directory.

## Architecture

**Entry point**: `src/extension.ts` — activates on `onStartupFinished`, registers providers/commands/watchers.

**Core singletons**:
- `src/DepService.ts` — manages workspace dependency graphs, file watchers, and incremental updates
- `src/core/DependencyGraph.ts` — adjacency-list graph (dependencyMap + dependentMap) with `enhanced-resolve` for webpack alias resolution. Processes files in parallel (concurrency limit: 10)
- `src/core/TreeSitterParser.ts` — WASM-based parser (web-tree-sitter) that extracts imports via tree-sitter queries. Lazy-loads language grammars (JS/TS/TSX) from `src/core/grammars/`. Caches parse trees with hash validation

**Providers** (implement VS Code language provider interfaces):
- `WebpackDefinitionProvider` — go-to-definition resolving webpack aliases and Vue component tags
- `VueOptionsCompletionProvider` — `this.` and `this.$` completions for Vue 2 Options API
- `VueOptionsDefinitionProvider` — definition navigation for Vue component properties
- `VueTemplateCompletionProvider` — completions in Vue template sections (mustache, @events, :binds)
- `UILibraryDefinitionProvider` — Element UI / Ant Design Vue component definitions
- `VueRangeFormattingProvider` — formats .vue SFC sections by delegating to built-in formatters

**Views**: `src/views/DepExplorerView.ts` — TreeDataProvider showing root → dependencies → dependents.

**Commands**: refresh, lock/unlock tree view, blockSelect (Ctrl+Shift+A), pasteAndIndent (Ctrl+Shift+V), funcEnhance (Alt+Enter).

## Key Patterns

- **Singleton pattern** for DepService, TreeSitterParser, DepExplorerView
- **Incremental updates**: file watcher triggers selective re-parsing, not full rebuilds
- **Caching**: parse trees cached by content hash; completion results cached by document version
- **Path resolution**: `enhanced-resolve` handles webpack aliases with fallback `@: src` mapping

## Build System

esbuild bundles to `dist/extension.js`. External dependencies (not bundled): `vscode`, `enhanced-resolve`, `web-tree-sitter`. TypeScript compiles to `out/` for tests only (tsconfig: ES6 target, CommonJS modules, strict mode).

## Extension Configuration Keys

All prefixed with `dependencyDependent.`: `entryPoints`, `excludes`, `debounceDelay`, `funcEnhance`, `pasteAndIndent.selectAfter`, `vue.customDollarProperties`.
