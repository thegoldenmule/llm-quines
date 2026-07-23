const s = `const s = \`@\`;
console.log(s.replace('@', () => s.replace(/[\\\\\`]/g, m => '\\\\' + m)));`;
console.log(s.replace('@', () => s.replace(/[\\`]/g, m => '\\' + m)));
