// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never mojibake
// (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again), never hold a
// control byte, and never say anything is encrypted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const DOCS = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];

/** Every text file of the repository (code, docs, workflows), node_modules and .git aside. */
function textFiles(dir = '', out = []) {
  for (const name of readdirSync(new URL(dir || '.', root))) {
    const path = `${dir}${name}`;
    if (['node_modules', '.git'].includes(name)) continue;
    if (statSync(new URL(path, root)).isDirectory()) {
      textFiles(`${path}/`, out);
    } else if (/\.(js|mjs|json|md|yml|yaml)$|^(Dockerfile|LICENSE|\.\w+ignore)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

for (const file of DOCS) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = readFileSync(new URL(file, root));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
});

test('no control byte in any text file (tab, LF and CR aside)', () => {
  const files = textFiles();
  assert.ok(files.length > 20, 'the walk found the files');
  for (const file of files) {
    const bytes = readFileSync(new URL(file, root));
    const bad = bytes.findIndex(
      (b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f,
    );
    assert.equal(bad, -1, `${file}: control byte at ${bad}`);
  }
});

test('never "encrypted" nor "chiffré"', () => {
  for (const file of DOCS) {
    const text = readFileSync(new URL(file, root), 'utf8');
    assert.doesNotMatch(text, /chiffr|encrypt/i, `${file} says encrypted`);
  }
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('LICENSE', root), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  const notices = readFileSync(new URL('THIRD_PARTY_NOTICES.md', root), 'utf8');
  assert.match(notices, /mennekes-amtron-ha/);
  assert.match(notices, /Copyright \(c\) 2026 nobelp/);
  assert.match(notices, /gladys-p1-monitor/);
  assert.match(notices, /gladys-solakon/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
});
