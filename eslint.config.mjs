import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.turbo/**', 'coverage/**', '*.tsbuildinfo'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-console': 'warn',
    },
  },
  {
    // T6.1 hardened-profile guard: Vault/OpenBao wiring is ADR-007 DEFERRED.
    // Blocks premature client imports project-wide until hardened implementation is unblocked.
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vault',
              message:
                "Vault/OpenBao integration is ADR-007 DEFERRED (Accepted as direction, zero runtime code). See docs/adr/007-hardened-openbao-vs-vault.md. Do not import 'vault' until hardened profile implementation is explicitly unblocked.",
            },
            {
              name: 'openbao',
              message:
                "Vault/OpenBao integration is ADR-007 DEFERRED (Accepted as direction, zero runtime code). See docs/adr/007-hardened-openbao-vs-vault.md. Do not import 'openbao' until hardened profile implementation is explicitly unblocked.",
            },
            {
              name: 'node-vault',
              message:
                "Vault/OpenBao integration is ADR-007 DEFERRED (Accepted as direction, zero runtime code). See docs/adr/007-hardened-openbao-vs-vault.md. Do not import 'node-vault' until hardened profile implementation is explicitly unblocked.",
            },
          ],
          patterns: [
            {
              group: ['vault/*', 'openbao/*', 'node-vault/*'],
              message:
                "Vault/OpenBao integration is ADR-007 DEFERRED (Accepted as direction, zero runtime code). See docs/adr/007-hardened-openbao-vs-vault.md. Subpath imports under 'vault', 'openbao', or 'node-vault' are also blocked until hardened profile implementation is explicitly unblocked.",
            },
          ],
        },
      ],
    },
  },
);
