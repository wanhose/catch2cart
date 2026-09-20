import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.chromium-profile/**',
      '*.cache.json',
      '.cardmarket-wishlist-cache.json',
      '.dorasuta-product-cache.json',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        document: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    extends: [tseslint.configs.recommended],
    rules: {
      eqeqeq: ['error', 'always'],
      'no-constant-condition': 'error',
      'no-duplicate-imports': 'error',
      'no-redeclare': 'error',
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          ignoreRestSiblings: true,
        },
      ],
      'prefer-const': 'error',
    },
  },
);
