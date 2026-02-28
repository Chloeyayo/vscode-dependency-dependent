export interface EnhanceResult {
  insertText: string;
  cursorLine: number;
  cursorChar: number;
  /** "insert" appends at end of line; "snippet" replaces the entire line */
  actionType: 'insert' | 'snippet';
}

const RE_DATA_FUNC = /^\s*data\s*\(\s*\)\s*\{\s*$/;
const RE_METHOD_NAME = /^\s*(async\s+)?(\w+)\s*$/;

/**
 * Compute function enhancement text for Alt+Enter smart code generation.
 *
 * Three matching branches:
 * 1. Line ends with `{` / `=> {` / `({` → insert newline + indent
 * 2. `data() {` → generate `return {}` template
 * 3. Bare method name (optional async) → generate full method template
 */
export function computeFuncEnhance(
  lines: string[],
  cursorLine: number,
  _cursorChar: number,
  tabSize: string,
): EnhanceResult | null {
  if (cursorLine >= lines.length) {
    return null;
  }

  const line = lines[cursorLine];
  const trimmed = line.trim();
  const indent = line.substring(0, line.length - line.trimStart().length);

  // Branch 1: generic function-like patterns ending with {
  if (trimmed.endsWith('{') || trimmed.endsWith('=> {') || trimmed.endsWith('({')) {
    const insert = '\n' + indent + tabSize;
    return {
      insertText: insert,
      cursorLine: cursorLine + 1,
      cursorChar: indent.length + tabSize.length,
      actionType: 'insert',
    };
  }

  // Branch 2: data() { → generate return {} template
  if (RE_DATA_FUNC.test(line)) {
    const inner = indent + tabSize;
    const insert = '\n' + inner + 'return {\n' + inner + tabSize + '\n' + inner + '}';
    return {
      insertText: insert,
      cursorLine: cursorLine + 2,
      cursorChar: indent.length + tabSize.length * 2,
      actionType: 'insert',
    };
  }

  // Branch 3: method name → generate method template
  const match = RE_METHOD_NAME.exec(trimmed);
  if (match) {
    const isAsync = !!match[1];
    const name = match[2];
    const asyncPrefix = isAsync ? 'async ' : '';
    const insert = indent + asyncPrefix + name + '() {\n' + indent + tabSize + '\n' + indent + '},';
    return {
      insertText: insert,
      cursorLine: cursorLine + 1,
      cursorChar: indent.length + tabSize.length,
      actionType: 'snippet',
    };
  }

  return null;
}
