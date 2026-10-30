import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/', 'web/.playwright/', 'web/test-results/', 'web/playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['api/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Shared with the browser: no Node built-ins in the money core.
    files: ['packages/money/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: '@hisaab/money runs in the browser too.' }] }],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Served as is, before the app: plain browser script.
    files: ['web/public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },
);
