const webTreeSitter = require('web-tree-sitter');
console.log('web-tree-sitter exports keys:', Object.keys(webTreeSitter));
console.log('web-tree-sitter type:', typeof webTreeSitter);
console.log('Parser:', webTreeSitter.Parser);
console.log('Parser.init:', webTreeSitter.Parser ? webTreeSitter.Parser.init : 'undefined');

try {
    const { Parser } = require('web-tree-sitter');
    console.log('Destructured Parser:', Parser);
} catch (e) {
    console.log('Destructuring failed:', e);
}
