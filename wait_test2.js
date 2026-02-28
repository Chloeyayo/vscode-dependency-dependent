const Parser = require('web-tree-sitter');

async function test() {
    await Parser.init();
    const lang = await Parser.Language.load('node_modules/web-tree-sitter/tree-sitter-typescript.wasm');
    const parser = new Parser();
    parser.setLanguage(lang);
    
    const tree = parser.parse(`
        export default {
            created() {
                if (true) {
                    this.a = 2;
                }
            }
        }
    `);
    
    let actions = [];
    const processNode = (node) => {
        if (!node) return;
        if (node.type === 'assignment_expression') {
            console.log('Found assignment:', node.text);
        }
        for (const child of node.children) {
            processNode(child);
        }
    };
    processNode(tree.rootNode);
}
test();
