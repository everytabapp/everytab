// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectInputs, buildGuide, checkGuide, writeGuide, OUTPUTS } from '../build-codebase-guide.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}
async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'everytab-guide-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'source with spaces');
  await mkdir(root);
  for (const file of ['guide-intro.md', 'explorer-template.html']) {
    await put(root, `tools/codebase/${file}`, await readFile(new URL(`../codebase/${file}`, import.meta.url)));
  }
  const catalogue = {
    'extension/js/a.js': 'Coordinates a synthetic operation.',
    'extension/js/b.js': 'Calculates its synthetic result.'
  };
  await put(root, 'tools/codebase/descriptions.json', JSON.stringify(catalogue));
  await put(root, 'extension/manifest.json', JSON.stringify({ version: '0.8.642', background: { service_worker: 'js/a.js' } }));
  await put(root, 'test-inventory.json', JSON.stringify({ entries: [] }));
  await put(root, 'README.md', '# Synthetic source\n');
  await put(root, 'extension/js/a.js', "import { value } from './b.js';\nexport const answer = value;\n");
  await put(root, 'extension/js/b.js', 'export const value = 42;\n');
  await put(root, '.github/workflows/check.yml', 'name: synthetic\n');
  return { root, temporary, catalogue };
}
async function linkOrSkip(t, target, destination, type) {
  try { await symlink(target, destination, type); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`OS does not permit synthetic symlinks (${error.code})`);
      return false;
    }
    throw error;
  }
}
async function outputState(root) {
  return Promise.all(OUTPUTS.map(async file => ({ file,
    bytes: await readFile(path.join(root, file)),
    mtime: (await stat(path.join(root, file), { bigint: true })).mtimeNs
  })));
}

test('collection has explicit roots and root files, excluding generated and unrelated data', async t => {
  const { root } = await fixture(t);
  const excluded = ['private-notes.md', 'archive/old.js', 'review-evidence/receipt.json',
    'docs/private.md', 'Vault/library.json', 'tools/node_modules/package/index.js',
    'extension/.private/data.json', ...OUTPUTS];
  for (const file of excluded) await put(root, file, 'OUTSIDE-SCOPE-SENTINEL');
  await put(root, 'ENGINEERING.md', '# Rules\n');
  const files = await collectInputs(root);
  assert.ok(files.includes('ENGINEERING.md'));
  assert.ok(files.includes('.github/workflows/check.yml'));
  assert.ok(files.includes('tools/codebase/guide-intro.md'));
  for (const file of excluded) assert.ok(!files.includes(file), `excluded: ${file}`);
  const { atlas, outputs } = await buildGuide(root);
  assert.deepEqual(atlas.scope.excludedGenerated, OUTPUTS);
  assert.ok(!JSON.stringify(outputs).includes('OUTSIDE-SCOPE-SENTINEL'));
});

test('collection skips file, nested directory and approved-root symlinks', async t => {
  const { root, temporary } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await put(outside, 'private.js', 'PRIVATE-SYMLINK-SENTINEL');
  if (!await linkOrSkip(t, path.join(outside, 'private.js'), path.join(root, 'extension/leak.js'), 'file')) return;
  if (!await linkOrSkip(t, outside, path.join(root, 'tools/linked'), 'dir')) return;
  await rm(path.join(root, '.github'), { recursive: true });
  if (!await linkOrSkip(t, outside, path.join(root, '.github'), 'dir')) return;
  await rm(path.join(root, 'README.md'));
  if (!await linkOrSkip(t, path.join(outside, 'private.js'), path.join(root, 'README.md'), 'file')) return;
  const files = await collectInputs(root);
  assert.ok(!files.some(file => file.includes('leak') || file.includes('linked') || file.startsWith('.github/')));
  assert.ok(!files.includes('README.md'));
  const { outputs } = await buildGuide(root);
  assert.ok(!JSON.stringify(outputs).includes('PRIVATE-SYMLINK-SENTINEL'));
});

test('generation is byte deterministic after output writes and relocation', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (const root of [first.root, second.root]) await put(root, 'extension/test/a #1.mjs', 'export {};\n');
  const before = await buildGuide(first.root);
  await writeGuide(first.root, before.outputs);
  const after = await buildGuide(first.root);
  assert.deepEqual(after, before, 'generated outputs never become their own source inputs');
  assert.deepEqual(await buildGuide(second.root), before, 'root location does not affect bytes or hashes');
  assert.ok(before.outputs['CODEBASE-GUIDE.md'].includes('(<extension/test/a%20%231.mjs>)'));
  for (const output of Object.values(before.outputs)) assert.ok(!output.includes(first.temporary));
});

test('literal imports and references are distinct, with reverse edges and no source execution', async t => {
  const { root } = await fixture(t);
  await put(root, 'extension/test/dynamic.mjs', 'throw new Error("Do not execute fixtures");');
  await put(root, 'extension/test/reference.mjs', 'export {};');
  await put(root, 'extension/test/ignored.mjs', 'export {};');
  await put(root, 'extension/js/a.js', [
    "import { value } from './b.js?fixture#value';",
    "export { value as renamed } from './b.js';",
    "await import('../test/dynamic.mjs');",
    "const reference = '../test/reference.mjs';",
    "const quoted = \"import '../test/ignored.mjs'\";",
    "/** @type {import('../test/ignored.mjs').Thing} */",
    "await import('../test/' + name);",
    "import '../../outside/private.js';",
    'globalThis.__guideSourceExecuted = true;',
    'throw new Error("Guide source must never execute");'
  ].join('\n'));
  const { atlas } = await buildGuide(root);
  const entry = file => atlas.entries.find(item => item.path === file);
  assert.deepEqual(entry('extension/js/a.js').imports, ['extension/js/b.js', 'extension/test/dynamic.mjs']);
  assert.deepEqual(entry('extension/js/a.js').references,
    ['extension/js/b.js', 'extension/test/dynamic.mjs', 'extension/test/reference.mjs']);
  assert.deepEqual(entry('extension/js/a.js').exports, ['renamed']);
  assert.deepEqual(entry('extension/js/b.js').importedBy, ['extension/js/a.js']);
  assert.deepEqual(entry('extension/test/ignored.mjs').importedBy, []);
  assert.deepEqual(entry('extension/manifest.json').references, ['extension/js/a.js']);
  assert.equal(globalThis.__guideSourceExecuted, undefined);
});

test('every runtime source needs a current explanation', async t => {
  const { root, catalogue } = await fixture(t);
  await put(root, 'extension/js/new.js', 'export {};');
  await assert.rejects(buildGuide(root), /Missing file explanation: extension\/js\/new\.js/);
  await rm(path.join(root, 'extension/js/new.js'));
  catalogue['extension/js/retired.js'] = 'Stale explanation.';
  await put(root, 'tools/codebase/descriptions.json', JSON.stringify(catalogue));
  await assert.rejects(buildGuide(root), /Explanation points to missing source: extension\/js\/retired\.js/);
});

for (const iconShape of ['string', 'size map']) {
  test(`manifest entrances include both options formats, content scripts and ${iconShape} action icons`, async t => {
    const { root } = await fixture(t);
    for (const file of ['options.html', 'settings.html', 'popup.html', 'side-panel.html', 'newtab.html']) {
      await put(root, `extension/${file}`, '<!doctype html><title>Synthetic entrance</title>');
    }
    await put(root, 'extension/css/content.css', 'body { color: inherit; }');
    for (const name of ['app', 'action16', 'action32']) {
      await put(root, `extension/icons/${name}.png`, Buffer.from([0, 1, 2]));
    }
    const defaultIcon = iconShape === 'string' ? 'icons/action16.png'
      : { 16: 'icons/action16.png', 32: 'icons/action32.png' };
    await put(root, 'extension/manifest.json', JSON.stringify({
      version: '0.8.642', background: { service_worker: 'js/a.js' },
      options_page: 'options.html', options_ui: { page: 'settings.html' },
      action: { default_popup: 'popup.html', default_icon: defaultIcon },
      side_panel: { default_path: 'side-panel.html' },
      chrome_url_overrides: { newtab: 'newtab.html' }, icons: { 128: 'icons/app.png' },
      content_scripts: [{ matches: ['https://example.invalid/*'], js: ['js/b.js'], css: ['css/content.css'] }]
    }));
    const { atlas } = await buildGuide(root);
    const manifest = atlas.entries.find(entry => entry.path === 'extension/manifest.json');
    const references = ['css/content.css', 'icons/action16.png', 'icons/app.png', 'js/a.js', 'js/b.js',
      'newtab.html', 'options.html', 'popup.html', 'settings.html', 'side-panel.html'];
    if (iconShape === 'size map') references.push('icons/action32.png');
    assert.deepEqual(manifest.references, references.map(file => `extension/${file}`).sort());
    assert.deepEqual(manifest.imports, [], 'manifest declarations are file references, not JS module imports');
    assert.ok(!atlas.entries.some(entry => entry.importedBy.includes('extension/manifest.json')),
      'declared entrances do not create misleading reverse JS import edges');
  });
}

test('explorer embeds source descriptions as escaped JSON', async t => {
  const { root, catalogue } = await fixture(t);
  catalogue['extension/js/a.js'] = '</script><script>globalThis.injected=true</script>';
  await put(root, 'tools/codebase/descriptions.json', JSON.stringify(catalogue));
  const { outputs } = await buildGuide(root);
  const html = outputs['CODEBASE-EXPLORER.html'];
  const payload = /<script id="atlas-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(payload);
  assert.ok(!payload.includes('<'));
  assert.equal(JSON.parse(payload).find(entry => entry.path === 'extension/js/a.js').description,
    catalogue['extension/js/a.js']);
});

test('freshness detects each missing or edited output and never writes', async t => {
  const { root } = await fixture(t);
  const { outputs } = await buildGuide(root);
  assert.deepEqual(await checkGuide(root, outputs), OUTPUTS);
  await writeGuide(root, outputs);
  const pristine = await outputState(root);
  assert.deepEqual(await checkGuide(root, outputs), []);
  assert.deepEqual(await outputState(root), pristine);
  for (const file of OUTPUTS) {
    await writeFile(path.join(root, file), `${outputs[file]} `);
    const changed = await outputState(root);
    assert.deepEqual(await checkGuide(root, outputs), [file]);
    assert.deepEqual(await outputState(root), changed, 'check does not repair content or update mtimes');
    await rm(path.join(root, file));
    assert.deepEqual(await checkGuide(root, outputs), [file]);
    await assert.rejects(stat(path.join(root, file)), { code: 'ENOENT' });
    await writeFile(path.join(root, file), outputs[file]);
  }
  await assert.rejects(stat(path.join(root, 'archive')), { code: 'ENOENT' });
});

for (const change of ['source edit', 'source addition', 'source deletion', 'template', 'metadata']) {
  test(`freshness catches ${change}`, async t => {
    const { root } = await fixture(t);
    await put(root, 'extension/test/existing.mjs', 'export {};');
    const before = await buildGuide(root);
    await writeGuide(root, before.outputs);
    if (change === 'source edit') await put(root, 'extension/js/b.js', 'export const value = 43;\n');
    if (change === 'source addition') await put(root, 'extension/test/new.mjs', 'export {};');
    if (change === 'source deletion') await rm(path.join(root, 'extension/test/existing.mjs'));
    if (change === 'template') await put(root, 'tools/codebase/guide-intro.md', '# New intro {{VERSION}}\n');
    if (change === 'metadata') await put(root, 'extension/manifest.json', '{"version":"0.8.643"}');
    const after = await buildGuide(root);
    assert.notEqual(after.atlas.sourceHash, before.atlas.sourceHash);
    assert.ok((await checkGuide(root, after.outputs)).includes('CODEBASE-ATLAS.json'));
  });
}

test('writes preserve every previous output by verified hash and are idempotent', async t => {
  const { root } = await fixture(t);
  const previous = Object.fromEntries(OUTPUTS.map(file => [file, `Prior ${file}\r\n`]));
  for (const [file, content] of Object.entries(previous)) await put(root, file, content);
  const { outputs } = await buildGuide(root);
  const result = await writeGuide(root, outputs);
  assert.deepEqual(result.changed, OUTPUTS);
  assert.match(result.archive, /^archive\/codebase-guides\/[a-f0-9]+$/);
  const index = await readFile(path.join(root, result.archive, 'INDEX.md'), 'utf8');
  for (const file of OUTPUTS) {
    const archived = await readFile(path.join(root, result.archive, file));
    assert.equal(archived.toString(), previous[file]);
    assert.ok(index.includes(`${file}): ${digest(archived)}`));
    assert.equal(await readFile(path.join(root, file), 'utf8'), outputs[file]);
  }
  const before = await outputState(root);
  assert.deepEqual(await writeGuide(root, outputs), { changed: [], archive: null });
  assert.deepEqual(await outputState(root), before);
  assert.deepEqual(await readdir(path.join(root, 'archive/codebase-guides')), [path.basename(result.archive)]);
});

test('writes refuse a symlink archive without changing outputs or outside files', async t => {
  const { root, temporary } = await fixture(t);
  for (const file of OUTPUTS) await put(root, file, `Old ${file}`);
  const outside = path.join(temporary, 'outside');
  await mkdir(outside);
  if (!await linkOrSkip(t, outside, path.join(root, 'archive'), 'dir')) return;
  const before = await outputState(root);
  const { outputs } = await buildGuide(root);
  await assert.rejects(writeGuide(root, outputs), /Unsafe archive directory/);
  assert.deepEqual(await outputState(root), before);
  assert.deepEqual(await readdir(outside), []);
});
