// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/** Build or verify the root learning files from explicitly scoped source inputs. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanJavaScript, scanFileReferences } from './codebase/source-graph.mjs';

export const OUTPUTS = ['CODEBASE-GUIDE.md', 'CODEBASE-EXPLORER.html', 'CODEBASE-ATLAS.json'];
export const ROOT_INPUTS = ['README.md', 'ARCHITECTURE.md', 'ENGINEERING.md', 'PRODUCT.md',
  'DESIGN.md', 'CONTEXT.md', 'TESTING.md', 'CHANGELOG.md', 'handoff-prompt.md', 'backlog.md',
  'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'test-inventory.json'];
const ROOTS = ['extension', 'tools', '.github'];
const TEXT = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml', '.py', '.sh']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ordered = values => [...new Set(values)].sort();
const link = (file, label = file) => `[${label}](<${file.split('/').map(encodeURIComponent).join('/')}>)`;
async function statOrNull(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Never follows directory or file symlinks, including the approved roots. */
export async function collectInputs(root) {
  const files = [];
  async function visit(relative) {
    const file = path.join(root, relative);
    const stat = await statOrNull(file);
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        await visit(`${relative}/${name}`);
      }
    } else if (stat.isFile()) files.push(relative);
  }
  for (const directory of ROOTS) await visit(directory);
  for (const file of ROOT_INPUTS) {
    const stat = await statOrNull(path.join(root, file));
    if (stat?.isFile() && !stat.isSymbolicLink()) files.push(file);
  }
  return files.sort();
}

function category(file) {
  if (file.startsWith('extension/js/')) return 'runtime';
  if (file.startsWith('extension/test/')) return 'tests';
  if (file.startsWith('extension/')) return 'pages';
  return file.startsWith('tools/') ? 'tools' : 'guides';
}
function describe(file, catalogue, inventory) {
  if (catalogue[file]) return catalogue[file];
  const entry = inventory.find(entry => entry.path === file);
  if (entry) return `${entry.kind === 'suite' ? 'Regression checks' : 'Development support'}: ${entry.reason}`;
  const name = path.posix.basename(file, path.posix.extname(file)).replaceAll('-', ' ');
  if (file === 'extension/manifest.json') return 'Chrome reads this permission sheet to find the app entrances, worker and icons.';
  if (file.endsWith('/messages.json')) return 'The word book used to translate product labels and feedback.';
  if (file.endsWith('.html')) return `The ${name} page skeleton; its references show the scripts and styles it loads.`;
  if (file.endsWith('.css')) return `Appearance rules for ${name}: layout, colors and controls.`;
  if (file.endsWith('.png')) return 'A packaged app icon; Chrome chooses a size for its surface.';
  if (file.startsWith('.github/')) return 'Automation configuration. CI selects checks from the shared test inventory.';
  return `Project guide or configuration: ${name}.`;
}
function resolveLocal(from, specifier, known) {
  if (typeof specifier !== 'string' || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(specifier)) return null;
  let decoded;
  try { decoded = decodeURIComponent(specifier.split(/[?#]/)[0]); } catch { return null; }
  const target = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1)
    : path.posix.join(path.posix.dirname(from), decoded));
  return known.has(target) ? target : null;
}

/** Deterministic in-memory render; no writes, module evaluation or browser effects. */
export async function buildGuide(root) {
  const files = await collectInputs(root);
  const known = new Set(files);
  const sources = new Map();
  for (const file of files) sources.set(file, await readFile(path.join(root, file)));
  const text = file => {
    if (!sources.has(file)) throw new Error(`Missing regular source input: ${file}`);
    return sources.get(file).toString('utf8');
  };
  const catalogue = JSON.parse(text('tools/codebase/descriptions.json'));
  const inventory = JSON.parse(text('test-inventory.json')).entries;
  const version = JSON.parse(text('extension/manifest.json')).version;
  for (const file of files.filter(file => category(file) === 'runtime')) {
    if (typeof catalogue[file] !== 'string' || !catalogue[file].trim()) throw new Error(`Missing file explanation: ${file}`);
  }
  for (const file of Object.keys(catalogue)) {
    if (!known.has(file)) throw new Error(`Explanation points to missing source: ${file}`);
  }
  const entries = files.map(file => {
    const bytes = sources.get(file);
    const extension = path.posix.extname(file);
    const source = TEXT.has(extension) || file === 'LICENSE' ? bytes.toString('utf8') : null;
    const scanned = ['.js', '.mjs'].includes(extension) ? scanJavaScript(source) : { imports: [], exports: [] };
    const imports = ordered(scanned.imports.filter(spec => spec.startsWith('.'))
      .map(spec => resolveLocal(file, spec, known)).filter(Boolean));
    let references = source === null ? [] : scanFileReferences(source, extension);
    if (file === 'extension/manifest.json') {
      const manifest = JSON.parse(source);
      references = [manifest.background?.service_worker, manifest.action?.default_popup,
        manifest.options_page, manifest.options_ui?.page, manifest.side_panel?.default_path,
        ...Object.values(manifest.chrome_url_overrides ?? {}), ...Object.values(manifest.icons ?? {}),
        ...(typeof manifest.action?.default_icon === 'string' ? [manifest.action.default_icon]
          : Object.values(manifest.action?.default_icon ?? {})),
        ...(manifest.content_scripts ?? []).flatMap(item => [...(item.js ?? []), ...(item.css ?? [])])];
    }
    return { path: file, description: describe(file, catalogue, inventory),
      lines: source === null ? null : source.split(/\r?\n/).length - Number(source.endsWith('\n')),
      bytes: bytes.length, sha256: sha256(bytes), imports,
      references: ordered([...imports, ...references.map(spec => resolveLocal(file, spec, known)).filter(Boolean)]),
      exports: ordered(scanned.exports), importedBy: [] };
  });
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) for (const target of entry.imports) byPath.get(target).importedBy.push(entry.path);
  const atlas = { schemaVersion: 1, version,
    scope: { roots: ROOTS, rootFiles: ROOT_INPUTS, excludedGenerated: OUTPUTS,
      exclusions: 'Symlinks, hidden/dependency files, arbitrary root files, archive, evidence, packages, personal data and other unlisted trees.',
      graph: 'Literal source relationships, not a call graph or test coverage. Computed imports, template bodies, messages, browser events and injected calls are not expanded.' },
    sourceHash: sha256(JSON.stringify(entries.map(({ path, sha256 }) => ({ path, sha256 })))), entries };
  let guide = text('tools/codebase/guide-intro.md').replaceAll('{{VERSION}}', version);
  const sections = [['pages', 'Entrances, styles, text, and assets'], ['runtime', 'Runtime files'],
    ['tests', 'Tests and fixtures'], ['tools', 'Developer tools'], ['guides', 'Automation and root guides']];
  for (const [area, title] of sections) {
    const group = entries.filter(entry => category(entry.path) === area);
    guide += `## ${title} (${group.length} files)\n\n`;
    for (const entry of group) {
      guide += `### ${entry.path}\n\n${link(entry.path, path.posix.basename(entry.path))}: ${entry.description}\n\n`;
      if (entry.imports.length) guide += `Uses modules: ${entry.imports.map(file => link(file)).join(', ')}.\n\n`;
      if (entry.importedBy.length) guide += `Imported by: ${entry.importedBy.map(file => link(file)).join(', ')}.\n\n`;
      const other = entry.references.filter(file => !entry.imports.includes(file));
      if (other.length) guide += `Other literal file references: ${other.map(file => link(file)).join(', ')}.\n\n`;
      if (entry.exports.length) guide += `Declared exports: ${entry.exports.map(name => '`' + name + '`').join(', ')}.\n\n`;
    }
  }
  const payload = JSON.stringify(entries).replaceAll('<', '\\u003c');
  const explorer = text('tools/codebase/explorer-template.html').replaceAll('{{VERSION}}', version)
    .replace('{{ATLAS_DATA}}', () => payload);
  return { atlas, outputs: { 'CODEBASE-GUIDE.md': guide, 'CODEBASE-EXPLORER.html': explorer,
    'CODEBASE-ATLAS.json': JSON.stringify(atlas, null, 2) + '\n' } };
}

/** Compare exact generated bytes; stale checks never rewrite or archive files. */
export async function checkGuide(root, outputs) {
  const stale = [];
  for (const [file, expected] of Object.entries(outputs)) {
    const stat = await statOrNull(path.join(root, file));
    if (!stat?.isFile() || stat.isSymbolicLink() || await readFile(path.join(root, file), 'utf8') !== expected) stale.push(file);
  }
  return stale;
}
async function ensureRealDirectory(root, relative) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await statOrNull(current);
    if (!stat) await mkdir(current);
    else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe archive directory: ${relative}`);
  }
}

/** Preserve prior outputs by content hash before replacing any generated file. */
export async function writeGuide(root, outputs) {
  const stale = await checkGuide(root, outputs);
  if (!stale.length) return { changed: [], archive: null };
  const previous = [];
  for (const file of OUTPUTS) {
    const stat = await statOrNull(path.join(root, file));
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-file output: ${file}`);
    previous.push({ path: file, bytes: await readFile(path.join(root, file)) });
  }
  let archive = null;
  if (previous.length) {
    const records = previous.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }));
    archive = `archive/codebase-guides/${sha256(JSON.stringify(records)).slice(0, 24)}`;
    await ensureRealDirectory(root, archive);
    for (const { path: file, bytes } of previous) {
      const target = path.join(root, archive, file);
      const stat = await statOrNull(target);
      if (!stat) await writeFile(target, bytes, { flag: 'wx' });
      else if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe archive file: ${file}`);
      if (sha256(await readFile(target)) !== sha256(bytes)) throw new Error(`Archive hash mismatch: ${file}`);
    }
    const index = '# Preserved generated guides\n\nOriginal root paths and SHA-256 hashes:\n\n' +
      records.map(row => `- [${row.path}](${row.path}): ${row.sha256}`).join('\n') +
      '\n\nReplaced by the current generated learning files at the project root.\n';
    const target = path.join(root, archive, 'INDEX.md');
    const stat = await statOrNull(target);
    if (!stat) await writeFile(target, index, { flag: 'wx' });
    else if (!stat.isFile() || stat.isSymbolicLink() || await readFile(target, 'utf8') !== index) throw new Error('Archive index differs');
  }
  for (const file of stale) await writeFile(path.join(root, file), outputs[file]);
  return { changed: stale, archive };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--write'].includes(args[0])) throw new Error('Use --check or --write');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const { atlas, outputs } = await buildGuide(root);
    if (args[0] === '--write') console.log(JSON.stringify(await writeGuide(root, outputs)));
    else {
      const stale = await checkGuide(root, outputs);
      if (stale.length) throw new Error(`Stale learning files: ${stale.join(', ')}. Run node tools/build-codebase-guide.mjs --write`);
      console.log(`PASS: current learning files; ${atlas.entries.length} source files; version ${atlas.version}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
