// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import { scanJavaScript, scanFileReferences } from '../codebase/source-graph.mjs';

const moduleSource = `
import './side.js';
import main, { a as b,
  c } from './multi.js';
import * as namespace from './namespace.js';
const value = import('./dynamic.js');
const options = import('./options.js', { with: { type: 'json' } });
const computed = import('./' + name);
export { b as renamed, c };
export { default as helper } from './helper.js';
export * from './all.js';
export * as more from './more.js';
export async function task() {}
export function* generator() {}
export class Thing {}
export const setting = 1, secondary = call(1, 2), third = { nested: [1, 2] };
export default function main() {}
`;
assert.deepEqual(scanJavaScript(moduleSource), {
  imports: ['./all.js', './dynamic.js', './helper.js', './more.js', './multi.js', './namespace.js', './options.js', './side.js'],
  exports: ['*', 'Thing', 'c', 'default', 'generator', 'helper', 'more', 'renamed', 'secondary', 'setting', 'task', 'third']
});
console.log('PASS: multiline imports, dynamic literals, named aliases and reexports');

const fixtures = [
  `// import './comment.js'\n/* export * from './block.js'; */\n/** @type {import('./types.js').Value} */`,
  `const quoted = "import './quoted.js'; export const pretend = 1";`,
  "const fixture = `import './template.js'; export { ghost } from './ghost.js'`;",
  "const fixture = `outer ${`import './nested.js'`} ${'import \\\"./nested-quoted.js\\\"'}`;",
  String.raw`const regex = /import\(['"]\.\/fake\.js['"]\)/g;`,
  String.raw`if (ok) /export.*from '.\/regex.js'/.test(value);`,
  `const object = { import: './property.js', export: './property.js' }; object.import('./method.js');`,
  "const computed = import(`./${name}.js`);",
  "const fixture = `outer ${/}/.test(value) ? `import './nested-regex.js'` : ''}`;",
];
for (const fixture of fixtures) assert.deepEqual(scanJavaScript(fixture), { imports: [], exports: [] });
assert.deepEqual(scanJavaScript(`const ratio = a / b; import('./real.js');`), { imports: ['./real.js'], exports: [] });
console.log('PASS: comments, JSDoc, strings, nested templates, regexes and methods are not imports');

assert.deepEqual(scanJavaScript(String.raw`import '.\x2fescaped\u002ejs'; export { item as 'public-name' };`), {
  imports: ['./escaped.js'], exports: ['public-name']
});
assert.deepEqual(scanJavaScript("import(`./literal.js`); import('./prefix.js' + suffix); import(path);"), {
  imports: ['./literal.js'], exports: []
});
assert.deepEqual(scanJavaScript('export const first = 1\nconst local = 2, privateHelper = 3;'), {
  imports: [], exports: ['first']
});
console.log('PASS: decoded specifiers, computed-import exclusions and local declaration boundaries');

assert.deepEqual(scanFileReferences(`
  const path = '../lib/read.js?mode=x';
  const fixture = "import '../not-a-reference.js'";
  // './comment.js'
  const templated = \`./\${name}.js\`;
  const simple = \`./literal.html\`;
  const regex = /'.\\/fake.js'/;
`, '.mjs'), ['./literal.html', '../lib/read.js?mode=x'].sort());
assert.deepEqual(scanFileReferences(`
<!-- <script src='ignored.js'></script> -->
<script src="js/main.js">const fixture = '<img src="ignored.png">';</script>
<link href='css/main.css?v=1&amp;x=2'>
<img src=icons/128.png data-src="ignored-data.png">
<div title="Read href='ignored-title.js'" data-text='src="ignored-text.js"'></div>
`, '.html'), ['css/main.css?v=1&x=2', 'icons/128.png', 'js/main.js']);
assert.deepEqual(scanFileReferences(`
/* @import 'ignored.css'; */
@import './base.css';
@import url("./layer.css");
body { background: url(../images/test.png); content: \"url(ignored.png)\"; }
`, '.css'), ['../images/test.png', './base.css', './layer.css'].sort());
console.log('PASS: separate literal JavaScript, HTML and CSS references');
