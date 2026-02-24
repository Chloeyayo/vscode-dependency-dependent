const Parser = require('web-tree-sitter');

(async () => {
    try {
        console.log('Before init: Language exists:', !!Parser.Language);
        await Parser.init();
        console.log('After init: Language exists:', !!Parser.Language);
        console.log('After init: Query exists:', !!Parser.Query);
    } catch (e) {
        console.error('Init failed:', e);
    }
})();
