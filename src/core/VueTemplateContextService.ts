import {
  type RootTemplateBounds,
} from "./vueTemplateUtils";

export type VueTemplateCompletionType = "mustache" | "event" | "bind";

export interface VueTemplateCompletionContext {
  type: VueTemplateCompletionType;
}

export interface VueOpenTagContext {
  tagName: string;
  tagStart: number;
  tagNameStart: number;
  tagNameEnd: number;
  existingAttributes: Set<string>;
}

export interface VueTagNameCompletionContext {
  partialName: string;
  replaceStartCharacter: number;
}

export class VueTemplateContextService {
  private static _instance: VueTemplateContextService | undefined;

  public static getInstance(): VueTemplateContextService {
    if (!this._instance) {
      this._instance = new VueTemplateContextService();
    }
    return this._instance;
  }

  public isInsideRootTemplate(bounds: RootTemplateBounds | null, offset: number): boolean {
    if (!bounds) {
      return false;
    }
    return offset > bounds.openTagEnd && offset < bounds.closeTagStart;
  }

  public detectCompletionContext(
    text: string,
    offset: number,
    linePrefix: string,
    bounds: RootTemplateBounds | null,
  ): VueTemplateCompletionContext | null {
    if (!this.isInsideRootTemplate(bounds, offset)) {
      return null;
    }

    if (this.isInsideMustache(text, offset, bounds)) {
      return { type: "mustache" };
    }

    const attrMatch = linePrefix.match(
      /(?:(@[\w-]+(?:\.[\w-]+)*)|(:[\w-]+(?:\.[\w-]+)*)|(v-on:[\w-]+(?:\.[\w-]+)*)|(v-bind:[\w-]+(?:\.[\w-]+)*)|(v-model(?:\.[\w-]+)*)|(v-(?:if|else-if|show|for|text|html)(?:\.[\w-]+)*))\s*=\s*(?:"[^"]*|'[^']*)$/,
    );
    if (!attrMatch) {
      return null;
    }

    if (attrMatch[1] || attrMatch[3]) {
      return { type: "event" };
    }

    return { type: "bind" };
  }

  public getOpenTagContext(
    text: string,
    offset: number,
    bounds: RootTemplateBounds | null,
  ): VueOpenTagContext | null {
    if (!this.isInsideRootTemplate(bounds, offset)) {
      return null;
    }

    const lowerBound = bounds ? bounds.openTagEnd + 1 : 0;
    const tagStart = this.findOpenTagStart(text, offset, lowerBound);

    if (tagStart === -1) {
      return null;
    }

    const rest = text.slice(tagStart + 1, offset);
    const match = rest.match(/^([\w-]+)/);
    if (!match) {
      return null;
    }

    const tagName = match[1];
    return {
      tagName,
      tagStart,
      tagNameStart: tagStart + 1,
      tagNameEnd: tagStart + 1 + tagName.length,
      existingAttributes: this.collectExistingAttributes(text.slice(tagStart, offset)),
    };
  }

  public getTagNameCompletionContext(
    linePrefix: string,
    cursorCharacter: number,
  ): VueTagNameCompletionContext | null {
    const tagMatch = linePrefix.match(/<([\w-]*)$/);
    if (!tagMatch) {
      return null;
    }

    return {
      partialName: tagMatch[1],
      replaceStartCharacter: cursorCharacter - tagMatch[1].length,
    };
  }

  private isInsideMustache(
    text: string,
    offset: number,
    bounds: RootTemplateBounds | null,
  ): boolean {
    const lowerBound = Math.max(1, (bounds?.openTagEnd ?? 0) + 1);
    let depth = 0;

    for (let i = offset - 1; i >= lowerBound; i--) {
      if (text[i] === "{" && text[i - 1] === "{") {
        if (depth === 0) {
          return true;
        }
        depth--;
        i--;
      } else if (text[i] === "}" && text[i - 1] === "}") {
        depth++;
        i--;
      }
    }

    return false;
  }

  private findOpenTagStart(text: string, offset: number, lowerBound: number): number {
    let searchOffset = offset;

    while (searchOffset > lowerBound) {
      const tagStart = text.lastIndexOf("<", searchOffset - 1);
      if (tagStart < lowerBound) {
        return -1;
      }

      const next = text[tagStart + 1];
      if (next === "/" || next === "!" || next === "?") {
        searchOffset = tagStart;
        continue;
      }

      if (this.isUnclosedOpenTag(text, tagStart, offset)) {
        return tagStart;
      }

      searchOffset = tagStart;
    }

    return -1;
  }

  private isUnclosedOpenTag(text: string, tagStart: number, offset: number): boolean {
    let inQuote: string | null = null;

    for (let i = tagStart + 1; i < offset; i++) {
      const ch = text[i];

      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        inQuote = ch;
        continue;
      }

      if (ch === ">") {
        return false;
      }
    }

    return true;
  }

  private collectExistingAttributes(tagText: string): Set<string> {
    const attrs = new Set<string>();
    const attrRe = /(?:^|\s)([:@]?[\w-]+)\s*(?:=|(?=\s|$|>|\/))/g;

    let match: RegExpExecArray | null;
    while ((match = attrRe.exec(tagText)) !== null) {
      const attrName = match[1].replace(/^[:@]/, "");
      attrs.add(attrName);
    }

    return attrs;
  }
}
