const Parser = require('web-tree-sitter');
console.log('Type of export:', typeof Parser);
console.log('Property names:', Object.getOwnPropertyNames(Parser));
console.log('Parser.init exists:', !!Parser.init);
console.log('Parser.Language exists:', !!Parser.Language);
console.log('Parser.Query exists:', !!Parser.Query);
