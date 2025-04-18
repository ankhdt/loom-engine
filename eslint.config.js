import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  // Apply ESLint recommended rules
  ...tseslint.config(eslint.configs.recommended, tseslint.configs.recommended),

  // Base configuration for all files
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: true
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '_.*',
          argsIgnorePattern: '_.*',
          caughtErrorsIgnorePattern: '_.*'
        }
      ]
    }
  },

  // Configuration for CLI TypeScript files
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },

  // Ignore distribution files
  {
    ignores: ['**/dist/**', '**/node_modules/**']
  }
];
