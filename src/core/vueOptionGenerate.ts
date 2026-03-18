import { TreeSitterParser } from "./TreeSitterParser";
import { getRootTemplateBounds } from "./vueTemplateUtils";

export interface VueOptionGenerateResult {
    /** Absolute offset in the full Vue document where text should be inserted/replaced */
    insertOffset: number;
    /** Text to insert */
    insertText: string;
    /** Name of the generated property/method */
    name: string;
    /** Which section it was generated into */
    section: 'data' | 'methods';
    /** If set, replace this many characters starting from insertOffset instead of pure insert */
    replaceLength?: number;
}

/**
 * Detect whether the identifier at cursor is an undefined reference in Vue Options API,
 * and generate the initialization code in the corresponding section.
 *
 * Context detection rules:
 *   - @click="xxx" / @submit="xxx" etc. event handlers  → methods
 *   - this.xxx() (call expression in script)              → methods
 *   - {{ xxx }} / :prop="xxx" / this.xxx (no call parens) → data
 */
export async function generateVueOption(
    content: string,
    cursorOffset: number,
    parser: TreeSitterParser
): Promise<VueOptionGenerateResult | null> {
    // --- 1. Determine cursor region (template vs script) and extract identifier ---
    const ref = extractReference(content, cursorOffset);
    if (!ref) return null;

    // --- 2. Check if already defined ---
    const index = await parser.getVueOptionsIndex(content);
    const allNames = new Set(index.properties.map(p => p.name));
    if (allNames.has(ref.name)) return null;

    // --- 3. Determine target section ---
    const section = ref.isMethod ? 'methods' as const : 'data' as const;

    // --- 4. Find insertion point ---
    const scriptInfo = parser.extractVueScriptInfo(content);
    if (!scriptInfo) return null;

    const { scriptContent, scriptOffset } = scriptInfo;
    const sectionInfo = await parser.findOptionSectionInsertInfo(scriptContent, section);
    if (!sectionInfo) return null;

    // Detect base indentation unit from the script content
    const baseIndent = detectIndent(scriptContent);
    // Level 1: direct children of export default {} (e.g. data, methods)
    const lv1 = baseIndent;
    // Level 2: inside data(){ return {} } or methods: {}
    const lv2 = baseIndent + baseIndent;
    // Level 3: properties inside data return object
    const lv3 = baseIndent + baseIndent + baseIndent;

    // --- 5. Build insertion text ---
    let insertText: string;
    const absoluteOffset = scriptOffset + sectionInfo.insertOffset;

    if (sectionInfo.type === 'existing') {
        // insertOffset points to the closing } of the section object.
        //
        // Original: "      configvaluekey: '',\n    }"
        // Target:   "      configvaluekey: '',\n      newProp: '',\n    }"
        //
        // We replace the indentation before } (from lineStart to closeIdx)
        // with: "<propIndent>newProp: '',\n<closingIndent>"
        const closeIdx = sectionInfo.insertOffset;

        // Find start of the line containing }
        let lineStart = closeIdx;
        while (lineStart > 0 && scriptContent[lineStart - 1] !== '\n' && scriptContent[lineStart - 1] !== '\r') {
            lineStart--;
        }
        const closingIndent = scriptContent.slice(lineStart, closeIdx);

        // Check if existing content needs a trailing comma
        const openOffset = sectionInfo.objectOpenOffset ?? scriptContent.lastIndexOf('{', closeIdx);
        const contentBetween = scriptContent.slice(openOffset, closeIdx).trim();
        const needsLeadingComma = contentBetween.length > 0
            && !contentBetween.endsWith(',')
            && !contentBetween.endsWith('{');

        const comma = needsLeadingComma ? ',' : '';
        const propIndent = closingIndent + baseIndent;

        // No leading \n — the newline before lineStart is kept as-is
        if (section === 'data') {
            insertText = `${comma}${propIndent}${ref.name}: '',\n${closingIndent}`;
        } else {
            insertText = `${comma}${propIndent}${ref.name}() {},\n${closingIndent}`;
        }

        return {
            insertOffset: scriptOffset + lineStart,
            insertText,
            name: ref.name,
            section,
            replaceLength: closeIdx - lineStart,
        };
    } else {
        // Section doesn't exist — create it after the opening { of export default
        if (section === 'data') {
            insertText = `\n${lv1}data() {\n${lv2}return {\n${lv3}${ref.name}: '',\n${lv2}};\n${lv1}},`;
        } else {
            insertText = `\n${lv1}methods: {\n${lv2}${ref.name}() {},\n${lv1}},`;
        }
    }

    return {
        insertOffset: absoluteOffset,
        insertText,
        name: ref.name,
        section,
    };
}

// ---- Internal helpers ----

interface ExtractedRef {
    name: string;
    isMethod: boolean;
}

/**
 * Extract the identifier at the cursor position and determine if it's a method call.
 */
function extractReference(content: string, offset: number): ExtractedRef | null {
    // Try template context first
    const templateRef = extractTemplateReference(content, offset);
    if (templateRef) return templateRef;

    // Try script context (this.xxx or this.xxx())
    return extractScriptReference(content, offset);
}

/**
 * Template context: detect {{ xxx }}, @event="xxx", :bind="xxx" etc.
 */
function extractTemplateReference(content: string, offset: number): ExtractedRef | null {
    const bounds = getRootTemplateBounds(content);
    if (!bounds) return null;
    if (offset <= bounds.openTagEnd || offset >= bounds.closeTagStart) return null;

    // Get the identifier at cursor
    const ident = getIdentifierAtOffset(content, offset);
    if (!ident) return null;

    // Look backwards from the identifier to determine context
    const before = content.slice(Math.max(0, bounds.openTagEnd), ident.start);

    // Check if inside @event="..."  →  methods
    // Match patterns like: @click="  @submit.prevent="  v-on:click="
    if (isInsideEventHandler(before, content, ident.end)) {
        return { name: ident.text, isMethod: true };
    }

    // Check if inside {{ }}  →  data (could also be a method but default to data)
    if (isInsideMustache(content, offset)) {
        // If followed by (, treat as method
        const afterIdent = content.slice(ident.end).match(/^\s*\(/);
        return { name: ident.text, isMethod: !!afterIdent };
    }

    // Check if inside :bind="..." / v-bind:xxx="..." / v-if="..." / v-show="..." etc.  →  data
    if (isInsideDirectiveValue(before, content, ident.end)) {
        const afterIdent = content.slice(ident.end).match(/^\s*\(/);
        return { name: ident.text, isMethod: !!afterIdent };
    }

    return null;
}

/**
 * Script context: detect this.xxx or this.xxx()
 */
function extractScriptReference(content: string, offset: number): ExtractedRef | null {
    // Get identifier at cursor
    const ident = getIdentifierAtOffset(content, offset);
    if (!ident) return null;

    // Check for `this.` prefix — look backwards from the identifier start
    const before = content.slice(Math.max(0, ident.start - 10), ident.start);
    if (!/this\.\s*$/.test(before)) return null;

    // Check if it's a method call: this.xxx(
    const after = content.slice(ident.end, Math.min(content.length, ident.end + 5));
    const isCall = /^\s*\(/.test(after);

    return { name: ident.text, isMethod: isCall };
}

function getIdentifierAtOffset(content: string, offset: number): { text: string; start: number; end: number } | null {
    // Expand from cursor to get the full identifier (word characters + $)
    let start = offset;
    let end = offset;

    // Expand left
    while (start > 0 && /[\w$]/.test(content[start - 1])) {
        start--;
    }
    // Expand right
    while (end < content.length && /[\w$]/.test(content[end])) {
        end++;
    }

    if (start === end) return null;

    const text = content.slice(start, end);
    // Must start with a letter or _ or $ (not a digit)
    if (!/^[a-zA-Z_$]/.test(text)) return null;

    return { text, start, end };
}

/**
 * Find the nearest unclosed attribute value quote before `identStart`.
 * Returns the quote char and the attribute prefix text, or null if not inside an attr value.
 */
function findUnclosedAttrValue(before: string): { quote: string; attrPrefix: string } | null {
    // Walk backwards to find the last unclosed quote that's part of an attribute value
    for (let i = before.length - 1; i >= 0; i--) {
        const ch = before[i];
        if (ch !== '"' && ch !== "'") continue;

        // Found a quote — scan forward to see if it's closed before the end
        let closed = false;
        for (let j = i + 1; j < before.length; j++) {
            if (before[j] === ch) { closed = true; break; }
        }
        if (closed) continue;

        // This quote is unclosed — check the text before it for a directive pattern
        const textBeforeQuote = before.slice(0, i);
        const attrPrefix = textBeforeQuote.match(/([@:]\S+|v-[\w:.-]+)\s*=\s*$/);
        if (attrPrefix) {
            return { quote: ch, attrPrefix: attrPrefix[1] };
        }
        return null;
    }
    return null;
}

/**
 * Check if the cursor is inside an event handler attribute value.
 */
function isInsideEventHandler(before: string, content: string, identEnd: number): boolean {
    const attr = findUnclosedAttrValue(before);
    if (!attr) return false;

    // Check the attribute name is an event handler
    if (!/^(@[\w.-]+|v-on:[\w.-]+)$/.test(attr.attrPrefix)) return false;

    // Verify the quote is closed after the identifier
    const afterIdent = content.slice(identEnd);
    return afterIdent.indexOf(attr.quote) >= 0;
}

/**
 * Check if cursor is inside a mustache {{ }} interpolation.
 */
function isInsideMustache(text: string, offset: number): boolean {
    let depth = 0;
    for (let i = offset - 1; i >= 1; i--) {
        if (text[i] === '{' && text[i - 1] === '{') {
            if (depth === 0) return true;
            depth--;
            i--;
        } else if (text[i] === '}' && text[i - 1] === '}') {
            depth++;
            i--;
        }
    }
    return false;
}

/**
 * Check if cursor is inside a directive value (:bind="...", v-if="...", etc.).
 */
function isInsideDirectiveValue(before: string, content: string, identEnd: number): boolean {
    const attr = findUnclosedAttrValue(before);
    if (!attr) return false;

    // Match bind / model / structural directives (but NOT event handlers — those are handled above)
    if (!/^(:[\w.-]+|v-bind:[\w.-]+|v-model[\w.-]*|v-(?:if|else-if|show|for|text|html)[\w.-]*)$/.test(attr.attrPrefix)) return false;

    const afterIdent = content.slice(identEnd);
    return afterIdent.indexOf(attr.quote) >= 0;
}

/**
 * Detect indentation from script content by looking at the first indented line.
 */
function detectIndent(scriptContent: string): string {
    const lines = scriptContent.split('\n');
    for (const line of lines) {
        const match = line.match(/^(\s+)\S/);
        if (match) {
            return match[1];
        }
    }
    return '  '; // fallback to 2 spaces
}
