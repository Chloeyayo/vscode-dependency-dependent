@echo off
REM Build tree-sitter wasm files for the extension
REM Prerequisites: emsdk installed at D:\emsdk, tree-sitter-cli@0.26.5 installed globally

REM Setup emsdk environment
call D:\emsdk\emsdk_env.bat

REM Verify tools
echo === Checking tools ===
call emcc --version
call tree-sitter --version

set GRAMMAR_DIR=D:\newWork\vscode-dependency-dependent\src\grammars

REM Build tree-sitter-vue
echo.
echo === Building tree-sitter-vue ===
cd /d D:\tree-sitter-vue
call tree-sitter build --wasm
if exist tree-sitter-vue.wasm (
    copy /Y tree-sitter-vue.wasm "%GRAMMAR_DIR%\tree-sitter-vue.wasm"
    echo tree-sitter-vue.wasm copied!
) else (
    echo ERROR: tree-sitter-vue.wasm not generated
)

REM Build tree-sitter-javascript
echo.
echo === Building tree-sitter-javascript ===
if not exist D:\tree-sitter-javascript (
    git clone https://github.com/tree-sitter/tree-sitter-javascript.git D:\tree-sitter-javascript
)
cd /d D:\tree-sitter-javascript
call npm install
call tree-sitter build --wasm
if exist tree-sitter-javascript.wasm (
    copy /Y tree-sitter-javascript.wasm "%GRAMMAR_DIR%\tree-sitter-javascript.wasm"
    echo tree-sitter-javascript.wasm copied!
) else (
    echo ERROR: tree-sitter-javascript.wasm not generated
)

REM Build tree-sitter-typescript
echo.
echo === Building tree-sitter-typescript ===
if not exist D:\tree-sitter-typescript (
    git clone https://github.com/tree-sitter/tree-sitter-typescript.git D:\tree-sitter-typescript
)
cd /d D:\tree-sitter-typescript
call npm install
call tree-sitter build --wasm typescript
if exist tree-sitter-typescript.wasm (
    copy /Y tree-sitter-typescript.wasm "%GRAMMAR_DIR%\tree-sitter-typescript.wasm"
    echo tree-sitter-typescript.wasm copied!
)
call tree-sitter build --wasm tsx
if exist tree-sitter-tsx.wasm (
    copy /Y tree-sitter-tsx.wasm "%GRAMMAR_DIR%\tree-sitter-tsx.wasm"
    echo tree-sitter-tsx.wasm copied!
)

echo.
echo === Done ===
dir "%GRAMMAR_DIR%\*.wasm"
pause
