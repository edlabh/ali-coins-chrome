/**
 * Verificação de sintaxe dinâmica de todos os módulos JS/MJS do repositório
 * + consistência de versão entre manifest.json e package.json.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...collectJsFiles(path.join(root, 'src')),
  ...collectJsFiles(path.join(root, 'tests')),
  ...collectJsFiles(path.join(root, 'tools')),
  path.join(root, 'eslint.config.js')
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  throw new Error(
    `Versão divergente: manifest.json (${manifest.version}) !== package.json (${pkg.version})`
  );
}

console.log(`✓ Syntax check concluído (${files.length} arquivos, v${manifest.version}).`);
