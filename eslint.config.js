// ESLint 10 flat config. Kept deliberately small: it catches real bugs (hooks rules, unused
// code, unsafe patterns), not formatting. `npm run lint` runs it over the whole repository.
const js = require('@eslint/js')
const tseslint = require('typescript-eslint')
const reactHooks = require('eslint-plugin-react-hooks')
const globals = require('globals')

module.exports = tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'resources/**', 'build/**', 'coverage/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // BOM / non-breaking space are matched on purpose inside strings and regular expressions.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipRegExps: true, skipTemplates: true, skipComments: true }],
      // Style only (an initial value that every branch overwrites).
      'no-useless-assignment': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Narrow `any` casts are used at SDK boundaries; the type checker covers the rest.
      '@typescript-eslint/no-explicit-any': 'off',
      // `import('x').Type` annotations are used for lazily loaded modules.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-require-imports': 'error'
    }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.ts', '*.config.*', '*.mts'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
)
