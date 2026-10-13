/**
 * Configuração ESLint (flat config).
 *
 * Estrutura do projeto:
 *  - src/background, src/common, src/popup, src/options → módulos ES
 *    (rodam no Chrome + testes no Node);
 *  - src/content → scripts clássicos injetados em página (self/document),
 *    com dois arquivos UMD (task-classify/ledger) avaliados nos testes;
 *  - tests → módulos ES com globals do Node.
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['icons/**', 'node_modules/**', 'docs/**'] },

  js.configs.recommended,

  {
    files: ['src/background/**/*.js', 'src/common/**/*.js', 'src/popup/**/*.js', 'src/options/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        chrome: 'readonly'
      }
    }
  },

  {
    files: ['src/content/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        module: 'writable',
        exports: 'writable'
      }
    }
  },

  {
    files: ['tests/**/*.js', 'eslint.config.js', 'tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    }
  },

  {
    files: ['**/*.js'],
    rules: {
      // `catch {}` intencionais (degradação graciosa) são permitidos com comentário.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  }
];
