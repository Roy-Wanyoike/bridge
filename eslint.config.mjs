// @ts-check
//
// Root ESLint flat config (issue #52, item 8).
//
// Scope: the workspace sources under packages/*/src — i.e. the flat glob
// "packages" + "/**" + "/src/**/*.ts" — only. `dashboard/` owns its own
// config and generated example output is machine-written, intentionally out
// of scope here.
//
// Policy is deliberately conservative: `typescript-eslint` recommended
// (non-type-checked) on top of `@eslint/js` recommended, with the noisy
// stylistic rules demoted to warnings (or off) so CI gates on real errors
// while still surfacing hygiene findings. `npm run lint` enforces
// `--max-warnings 25`.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'bridge/ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // Generated / vendored output — never lint machine-written code.
      'examples/**',
      '**/generated/**',
      // Separate toolchain with its own flat config.
      'dashboard/**',
    ],
  },
  {
    name: 'bridge/packages-src',
    files: ['packages/**/src/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // ---- off: pre-existing codebase-wide findings --------------------
      // ~70 latent unused vars/imports across packages; removing them means
      // touching application code, which is out of scope for the CI PR.
      // Tracked for the dead-code wave — re-enable there.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // ---- demoted to warnings: hygiene findings, not correctness ----
      // Regex/style escapes are intentional in parser + fixture code
      // (`\@` guards, space-runs matched literally).
      'no-useless-escape': 'warn',
      'no-regex-spaces': 'warn',
      // `require()` appears in two lazy-load paths + one test helper.
      '@typescript-eslint/no-require-imports': 'warn',
      'no-constant-condition': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
);
