/**
 * Shared utility for detecting root-level <template> boundaries in Vue SFCs.
 * Used by template-related completion/definition providers to avoid matching
 * nested <template v-if>, <template v-slot>, etc.
 */

export interface RootTemplateBounds {
    openTagStart: number;
    openTagEnd: number;
    closeTagStart: number;
    closeTagEnd: number;
}

/**
 * 获取根级 <template> 的边界（要求标签位于行首）。
 */
export function getRootTemplateBounds(text: string): RootTemplateBounds | null {
    const openMatch = /^<template(\b[^>]*)?>/im.exec(text);
    if (!openMatch || openMatch.index === undefined) {
        return null;
    }

    const openTagStart = openMatch.index;
    const openTagEnd = openTagStart + openMatch[0].length - 1;
    const searchStart = openTagEnd + 1;

    const closeMatch = /^<\/template\s*>/im.exec(text.substring(searchStart));
    if (!closeMatch || closeMatch.index === undefined) {
        return null;
    }

    const closeTagStart = searchStart + closeMatch.index;
    const closeTagEnd = closeTagStart + closeMatch[0].length - 1;
    if (closeTagStart <= openTagEnd) {
        return null;
    }

    return {
        openTagStart,
        openTagEnd,
        closeTagStart,
        closeTagEnd,
    };
}

/**
 * Check if offset is inside the root-level <template> block.
 */
export function isOffsetInsideRootTemplate(text: string, offset: number): boolean {
    const bounds = getRootTemplateBounds(text);
    if (!bounds) {
        return false;
    }
    return offset > bounds.openTagEnd && offset < bounds.closeTagStart;
}
