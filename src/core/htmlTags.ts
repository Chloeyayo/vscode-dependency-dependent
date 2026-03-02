/**
 * Common HTML native element tags.
 * Used to exclude native elements from component-specific features
 * (auto-import, props completion, etc.)
 */
export const NATIVE_HTML_TAGS = new Set([
    'div', 'span', 'p', 'a', 'button', 'input', 'form', 'table', 'tr', 'td', 'th',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'video', 'audio',
    'select', 'option', 'optgroup', 'label', 'header', 'footer', 'main', 'section',
    'article', 'nav', 'aside', 'figure', 'figcaption', 'template', 'slot', 'style',
    'script', 'canvas', 'iframe', 'textarea', 'pre', 'code', 'hr', 'br', 'strong',
    'em', 'b', 'i', 'u', 's', 'small', 'big', 'sub', 'sup', 'blockquote', 'q',
    'cite', 'abbr', 'acronym', 'address', 'map', 'area', 'object', 'param', 'embed',
    'fieldset', 'legend', 'caption', 'col', 'colgroup', 'thead', 'tbody', 'tfoot',
    'dd', 'dl', 'dt', 'menu', 'menuitem', 'summary', 'details', 'dialog', 'data',
    'datalist', 'output', 'progress', 'meter', 'time', 'mark', 'ruby', 'rt', 'rp',
    'bdi', 'bdo', 'wbr', 'picture', 'source', 'track', 'noscript', 'html', 'head',
    'body', 'base', 'link', 'meta', 'title', 'keygen', 'del', 'ins', 'svg', 'path',
    'g', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse', 'text', 'use',
    'defs', 'symbol', 'mask', 'clippath', 'filter', 'image', 'pattern',
    'radialGradient', 'linearGradient', 'stop', 'animate', 'animateTransform',
    'animateMotion', 'set',
    'transition', 'keep-alive', 'component', 'router-view', 'router-link',
]);
