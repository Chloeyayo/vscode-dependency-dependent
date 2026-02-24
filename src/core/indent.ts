'use strict';

export interface IndentOptions {
    insertSpaces: boolean;
    tabSize: number;
}

/**
 * Reindent multi-line text to align with a target offset.
 * Pure function — no VS Code API dependency.
 *
 * @param text       The clipboard text to reindent
 * @param offset     The target indentation column (number of indent chars)
 * @param options    insertSpaces and tabSize from editor settings
 * @returns          The reindented text, or the original text if no adjustment needed
 */
export function reindentText(
    text: string,
    offset: number,
    options: IndentOptions
): string {
    const lines = text.split('\n');

    // Single line: no indentation adjustment
    if (lines.length <= 1) {
        return text;
    }

    const { insertSpaces, tabSize } = options;
    const indentChar = insertSpaces ? ' ' : '\t';

    // Compute normalized leading whitespace for each line
    const leadingSpaces: number[] = new Array(lines.length);
    let xmin: number | undefined;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let ls = line.search(/\S/);
        if (ls !== -1) {
            if (insertSpaces) {
                // Count tabs in leading whitespace and expand them
                const leading = line.substring(0, ls);
                let tabCount = 0;
                for (let j = 0; j < leading.length; j++) {
                    if (leading.charCodeAt(j) === 9) { tabCount++; }
                }
                ls += tabCount * (tabSize - 1);
            } else {
                // Count non-tab chars in leading whitespace and subtract
                const leading = line.substring(0, ls);
                let nonTabCount = 0;
                for (let j = 0; j < leading.length; j++) {
                    if (leading.charCodeAt(j) !== 9) { nonTabCount++; }
                }
                ls -= nonTabCount;
            }
            // Skip first line for xmin calculation
            if (i > 0 && (xmin === undefined || ls < xmin)) {
                xmin = ls;
            }
        }
        leadingSpaces[i] = ls;
    }

    // No adjustment needed
    if (xmin === 0 && offset === 0) {
        return text;
    }

    const xminSafe = xmin ?? 0;
    const parts: string[] = new Array(lines.length);

    for (let i = 0; i < lines.length; i++) {
        const x = leadingSpaces[i];
        if (i === 0) {
            // First line: keep as-is
            parts[i] = lines[i];
        } else if (x === -1) {
            // Blank line: strip whitespace
            parts[i] = lines[i].replace(/^\s*/, '');
        } else {
            const indent = indentChar.repeat(x - xminSafe + offset);
            parts[i] = lines[i].replace(/^\s*/, indent);
        }
    }

    return parts.join('\n');
}
