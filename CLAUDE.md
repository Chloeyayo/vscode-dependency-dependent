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
npm run deploy                  # Publish to VS Code Marketplace (vsce publish --yarn)
```

The esbuild step produces **two bundles**: `dist/extension.js` (main extension) and `dist/ts-plugin.js` (TypeScript server plugin). Both are built from the single `esbuild-base` script.

Debug with F5 in VS Code — launches extension in a new Extension Development Host window. Tests run via `@vscode/test-electron` with Mocha (TDD UI, 60s timeout) against the `test-project/` fixture directory. Test files live in `src/test/suite/**/*.test.ts`.

### Tree-sitter WASM Grammars

Grammar `.wasm` files live in `src/grammars/` (dev) or `grammars/` (packaged). Two scripts to obtain them:
- `node scripts/download-wasm.js` — downloads prebuilt WASM from `tree-sitter-wasms@0.0.97` (must match ABI 14 for `web-tree-sitter@0.22.6`)
- `node scripts/build-wasm.js [--docker]` — builds locally using `tree-sitter-cli@0.20.8` (requires Emscripten SDK or Docker)

## Architecture

**Entry point**: `src/extension.ts` — activates on `onStartupFinished`, registers all providers/commands/watchers and initializes singletons.

### Two-Layer Vue `<script>` Intelligence

The extension uses a **TS Server Plugin + Extension Provider** split to give `.vue` files full JS/TS language support:

1. **TS Server Plugin** (`src/ts-plugin/index.ts`) — registered via `package.json` `typescriptServerPlugins`. Intercepts `LanguageServiceHost` to feed tsserver a "space-padded" version of `.vue` files where everything outside `<script>` is replaced with spaces (preserving newlines for 1:1 offset mapping). This gives `.vue` files native completions, hover, diagnostics, signature help, references, and rename — all from VS Code's built-in TS/JS service. The plugin yields `this.`/`this.$` completions back to the extension side by returning `undefined`, and filters diagnostics to only report within `<script>` regions.

2. **Extension-side Providers** — handle Vue-specific intelligence that tsserver cannot provide:
   - `VueOptionsCompletionProvider` — `this.` and `this.$` completions for Vue 2 Options API (`.`, `$` triggers)
   - `VueOptionsDefinitionProvider` — go-to-definition for Vue component properties
   - `VueTemplateCompletionProvider` — completions in `<template>` (mustache `{{`, @events, :binds)
   - `VueComponentPropsCompletionProvider` — sub-component props completion (space trigger)
   - `VueComponentTagCompletionProvider` — component tag auto-complete/import (`<` trigger)
   - `UILibraryDefinitionProvider` — Element UI / Ant Design Vue component definitions
   - `WebpackDefinitionProvider` — go-to-definition resolving webpack aliases (works for all JS/TS/Vue files)
   - `VueRangeFormattingProvider` — formats `.vue` SFC sections by delegating to built-in formatters

### Core Singletons

- `src/DepService.ts` — manages workspace dependency graphs, file watchers, and incremental updates
- `src/core/DependencyGraph.ts` — adjacency-list graph (dependencyMap + dependentMap) with `enhanced-resolve` for webpack alias resolution. Processes files in parallel (concurrency limit: 10)
- `src/core/TreeSitterParser.ts` — WASM-based parser (web-tree-sitter) that extracts imports via tree-sitter queries. Lazy-loads language grammars (JS/TS/TSX/Vue) from `src/core/grammars/`. Caches parse trees with hash validation
- `src/core/VuePrototypeScanner.ts` — scans `node_modules` for Vue plugins that add `$xxx` prototype properties; shared between completion and definition providers

### Views

- `src/views/DepExplorerView.ts` — TreeDataProvider showing root → dependencies → dependents
- `src/views/VueTimelineProvider.ts` — Vue 2 lifecycle timeline view with variable tracking mode

### Commands

- refresh, lock/unlock tree view
- blockSelect (Ctrl+Shift+A) — expand selection to enclosing bracket/quote pair
- pasteAndIndent (Ctrl+Shift+V) — paste with automatic re-indentation
- funcEnhance (Alt+Enter) — smart code generation
- vueTimeline.trackVariable — right-click to track `this.xxx` across lifecycle hooks

## Key Patterns

- **Singleton pattern** for DepService, TreeSitterParser, DepExplorerView (accessed via `.singleton` static property)
- **Incremental updates**: file watcher triggers selective re-parsing, not full rebuilds
- **Caching**: parse trees cached by content hash; completion results cached by document version; TS plugin caches extracted script content by file version
- **Path resolution**: `enhanced-resolve` handles webpack aliases with fallback `@: src` mapping
- **Document selectors**: Vue providers use `[{ scheme: "file", pattern: "**/*.vue" }]` (pattern-based, not language ID)

## Build System

esbuild bundles to `dist/extension.js` + `dist/ts-plugin.js`. External dependencies (not bundled): `vscode`, `enhanced-resolve`, `web-tree-sitter`. TypeScript compiles to `out/` for tests only (tsconfig: ES6 target, CommonJS modules, strict mode). The `.vscodeignore` ensures `src/grammars/` WASM files are included in the packaged extension but TypeScript source is excluded.

## Extension Configuration Keys

All prefixed with `dependencyDependent.`: `entryPoints`, `excludes`, `debounceDelay`, `funcEnhance`, `pasteAndIndent.selectAfter`, `vue.customDollarProperties`. Additionally `typescript-plugins.suggest.enabled` controls TS plugin completions.
