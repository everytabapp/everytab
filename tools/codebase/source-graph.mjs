// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

/**
 * Partial, nonexecuting source graph for the codebase guide. This lexical scan
 * recognizes literal module syntax, not calls, ownership or coverage. It does
 * not resolve computed imports, evaluate templates, or expand wildcard exports.
 * Regex versus division uses token context, not a full JavaScript grammar;
 * unusual ambiguous syntax should be checked against the source itself.
 */
const IDENTIFIER = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const REGEX_PREFIX_WORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of',
  'instanceof', 'yield', 'await', 'else', 'do'
]);
const CONTROL_PARENS = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);

function escapeAt(source, index) {
  const char = source[index];
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (char === '\n') return { value: '', end: index + 1 };
  if (char === '\r') return { value: '', end: index + (source[index + 1] === '\n' ? 2 : 1) };
  if (Object.hasOwn(simple, char)) return { value: simple[char], end: index + 1 };
  if (char === 'x' && /^[\da-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
    return { value: String.fromCharCode(parseInt(source.slice(index + 1, index + 3), 16)), end: index + 3 };
  }
  if (char === 'u') {
    const braced = /^\{([\da-f]{1,6})\}/i.exec(source.slice(index + 1));
    if (braced && parseInt(braced[1], 16) <= 0x10ffff) {
      return { value: String.fromCodePoint(parseInt(braced[1], 16)), end: index + 1 + braced[0].length };
    }
    const hex = source.slice(index + 1, index + 5);
    if (/^[\da-f]{4}$/i.test(hex)) return { value: String.fromCharCode(parseInt(hex, 16)), end: index + 5 };
  }
  return { value: char ?? '', end: index + 1 };
}

function quoted(source, start) {
  const quote = source[start];
  let value = '';
  let computed = false;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const escaped = escapeAt(source, index + 1);
      value += escaped.value;
      index = escaped.end;
    } else if (char === quote) {
      return { type: quote === '`' ? 'template' : 'string', value, computed, end: index + 1 };
    } else if (quote === '`' && char === '$' && source[index + 1] === '{') {
      // Skip interpolated expressions as well as text. An imported module in
      // such an expression is deliberately outside this partial graph.
      computed = true;
      index = skipTemplateExpression(source, index + 2);
    } else { value += char; index++; }
  }
  return { type: 'invalid', value, computed, end: index };
}

function regexEnd(source, start) {
  let inClass = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === '\n' || char === '\r') return start + 1;
    if (char === '\\') { index++; continue; }
    if (char === '[') inClass = true;
    if (char === ']') inClass = false;
    if (char === '/' && !inClass) {
      index++;
      while (/[A-Za-z]/.test(source[index] ?? '')) index++;
      return index;
    }
  }
  return start + 1;
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  let index = start;
  let regexAllowed = true;
  let previous;
  const parens = [];
  while (index < source.length && depth) {
    const char = source[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '"' || char === "'" || char === '`') {
      index = quoted(source, index).end;
      regexAllowed = false;
      previous = 'literal';
    } else if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (char === '/' && regexAllowed && regexEnd(source, index) > index + 1) {
      index = regexEnd(source, index);
      regexAllowed = false;
      previous = 'literal';
    } else if (IDENTIFIER.test(char)) {
      const wordStart = index++;
      while (IDENTIFIER_PART.test(source[index] ?? '')) index++;
      previous = source.slice(wordStart, index);
      regexAllowed = REGEX_PREFIX_WORDS.has(previous);
    } else if (/\d/.test(char)) {
      index++;
      while (/[\w.]/.test(source[index] ?? '')) index++;
      regexAllowed = false;
      previous = 'literal';
    } else {
      if (char === '{') depth++;
      if (char === '}') depth--;
      if (char === '(') parens.push(CONTROL_PARENS.has(previous));
      regexAllowed = char === ')' ? parens.pop() === true : ![']', '.'].includes(char);
      previous = char;
      index++;
    }
  }
  return index;
}

function tokenize(source) {
  const tokens = [];
  const parens = [];
  let regexAllowed = true;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index++; continue; }
    if (source.startsWith('//', index) || (index === 0 && source.startsWith('#!', index))) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const token = quoted(source, index);
      tokens.push(token);
      index = token.end;
      regexAllowed = false;
      continue;
    }
    if (char === '/' && regexAllowed) {
      const end = regexEnd(source, index);
      if (end > index + 1) {
        tokens.push({ type: 'regex', value: '' });
        index = end;
        regexAllowed = false;
        continue;
      }
    }
    if (IDENTIFIER.test(char)) {
      const start = index++;
      while (IDENTIFIER_PART.test(source[index] ?? '')) index++;
      const value = source.slice(start, index);
      tokens.push({ type: 'identifier', value });
      regexAllowed = REGEX_PREFIX_WORDS.has(value);
      continue;
    }
    if (/\d/.test(char)) {
      const start = index++;
      while (/[\w.]/.test(source[index] ?? '')) index++;
      tokens.push({ type: 'number', value: source.slice(start, index) });
      regexAllowed = false;
      continue;
    }
    const previous = tokens.at(-1)?.value;
    const value = ['++', '--', '?.', '=>'].includes(source.slice(index, index + 2))
      ? source.slice(index, index + 2) : char;
    if (value === '(') parens.push(CONTROL_PARENS.has(previous));
    if (value === ')') regexAllowed = parens.pop() === true;
    else regexAllowed = ![']', '.', '?.', '++', '--'].includes(value);
    tokens.push({ type: 'punctuation', value });
    index += value.length;
  }
  return tokens;
}

const literal = (token) => token?.type === 'string' || (token?.type === 'template' && !token.computed);
const unique = (values) => [...new Set(values)].sort();

/**
 * Literal imports include static imports, dynamic imports and re-export sources.
 * Export names include aliases/default and '*' for an unexpanded wildcard.
 * Destructured export declarations are not expanded; use explicit export lists
 * when an exact exported-name inventory is needed for those declarations.
 * @param {string} source
 * @returns {{imports:string[], exports:string[]}}
 */
export function scanJavaScript(source) {
  const tokens = tokenize(source);
  const imports = [];
  const exports = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'identifier' || !['import', 'export'].includes(token.value)) continue;
    if (['.', '?.'].includes(tokens[index - 1]?.value)) continue;
    const next = tokens[index + 1];
    if (token.value === 'import') {
      if (next?.value === '(') {
        const spec = tokens[index + 2];
        if (literal(spec) && [')', ','].includes(tokens[index + 3]?.value)) imports.push(spec.value);
      } else if (next?.type === 'string') imports.push(next.value);
      else if (next?.type === 'identifier' || ['{', '*'].includes(next?.value)) {
        for (let cursor = index + 2; cursor < tokens.length; cursor++) {
          if ([';', 'import', 'export'].includes(tokens[cursor].value)) break;
          if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.type === 'string') {
            imports.push(tokens[cursor + 1].value); break;
          }
        }
      }
      continue;
    }
    let cursor = index + 1;
    if (next?.value === 'default') { exports.push('default'); continue; }
    if (next?.value === '{') {
      cursor++;
      while (cursor < tokens.length && tokens[cursor].value !== '}') {
        const name = tokens[cursor];
        if (name.type === 'identifier' || name.type === 'string') {
          if (tokens[cursor + 1]?.value === 'as') {
            exports.push(tokens[cursor + 2]?.value);
            cursor += 3;
          } else { exports.push(name.value); cursor++; }
        } else cursor++;
      }
      cursor++;
    } else if (next?.value === '*') {
      if (tokens[index + 2]?.value === 'as') {
        exports.push(tokens[index + 3]?.value); cursor = index + 4;
      } else { exports.push('*'); cursor = index + 2; }
    } else {
      if (tokens[cursor]?.value === 'async') cursor++;
      const declaration = tokens[cursor]?.value;
      if (['function', 'class', 'const', 'let', 'var'].includes(declaration)) {
        cursor++;
        if (tokens[cursor]?.value === '*') cursor++;
        if (tokens[cursor]?.type === 'identifier') exports.push(tokens[cursor].value);
        if (['const', 'let', 'var'].includes(declaration)) {
          let depth = 0;
          for (; cursor < tokens.length; cursor++) {
            const value = tokens[cursor].value;
            if (depth === 0 && [';', 'export', 'import', 'const', 'let', 'var'].includes(value)) break;
            if (['(', '[', '{'].includes(value)) depth++;
            if ([')', ']', '}'].includes(value)) depth--;
            if (value === ',' && depth === 0 && tokens[cursor + 1]?.type === 'identifier') {
              exports.push(tokens[cursor + 1].value);
            }
          }
        }
      }
      continue;
    }
    if (tokens[cursor]?.value === 'from' && tokens[cursor + 1]?.type === 'string') {
      imports.push(tokens[cursor + 1].value);
    }
  }
  return { imports: unique(imports), exports: unique(exports.filter(Boolean)) };
}

function decodeHtml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

/**
 * Literal file references are separate from executable imports. HTML/CSS scans
 * cover quoted/unquoted attributes and CSS import/url forms, not DOM mutation,
 * template-generated attributes or a complete stylesheet/HTML parse.
 * Manifest entry points are handled by the caller's explicit JSON schema.
 * @param {string} source
 * @param {string} extension File suffix, with or without its leading dot.
 * @returns {string[]}
 */
export function scanFileReferences(source, extension) {
  const kind = extension.replace(/^\./, '').toLowerCase();
  const references = [];
  if (['js', 'mjs', 'cjs'].includes(kind)) {
    for (const token of tokenize(source)) {
      if (literal(token) && /^\.\.?\/[^\n\r]*\.[\w-]+(?:[?#].*)?$/.test(token.value)) references.push(token.value);
    }
  } else if (kind === 'html') {
    const clean = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      (block) => block.slice(0, block.indexOf('>') + 1));
    for (const tag of clean.matchAll(/<[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
      // Consume whole attribute values before looking for another name, so
      // text such as title="Read href='example.js'" is never a relationship.
      for (const attribute of tag[0].matchAll(/\s+([^\s="'<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        if (!['src', 'href'].includes(attribute[1].toLowerCase())) continue;
        const value = attribute[2] ?? attribute[3] ?? attribute[4];
        if (value !== undefined) references.push(decodeHtml(value));
      }
    }
  } else if (kind === 'css') {
    let index = 0;
    while (index < source.length) {
      if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (['"', "'"].includes(source[index])) { index = quoted(source, index).end; continue; }
      const rest = source.slice(index);
      const imported = /^@import\s+/i.exec(rest);
      const url = /^url\(\s*/i.exec(rest);
      if (imported) {
        index += imported[0].length;
        if (['"', "'"].includes(source[index])) {
          const value = quoted(source, index);
          references.push(value.value);
          index = value.end;
        }
        continue;
      }
      if (url && !/[\w-]/.test(source[index - 1] ?? '')) {
        index += url[0].length;
        if (['"', "'"].includes(source[index])) {
          const value = quoted(source, index);
          references.push(value.value);
          index = value.end;
        } else {
          const end = source.indexOf(')', index);
          if (end >= 0) { references.push(source.slice(index, end).trim()); index = end + 1; }
        }
        continue;
      }
      index++;
    }
  }
  return unique(references);
}
