import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build outputs (the native shell's Rust and Android builds write JS there too), and the local-only studio
  globalIgnores(['dist', 'coverage', 'drizzle', 'drizzle.config.ts', 'src-tauri/target', 'src-tauri/gen', '.claude', 'studio']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // shadcn convention: variant helpers live next to their component
      'react-refresh/only-export-components': ['error', { allowExportNames: ['buttonVariants'] }],
      // Async event handlers (onClick={async …}) are fine in React.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // tRPC procedures and mocks are async by contract, awaiting or not.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Tests poke at untyped mock bodies and JSON on purpose.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
  {
    files: ['api/**/*.ts', 'db/**/*.ts', 'contracts/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Issue links come from issuePath (src/lib/issues.ts): by identity when known.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/issues.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateLiteral > TemplateElement[value.raw=/^\\/issues\\//]',
          message: 'Link to an issue with issuePath() from @/lib/issues.',
        },
        {
          // The app decides by capability, never by which service it is (§4.1).
          selector: "BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^(jira|github|gitlab|azure|gitea|linear|youtrack|shortcut|plane|openproject|redmine|trello|asana|clickup|monday|notion|wrike|basecamp|todoist|planner|tempo|harvest|clockify|toggl|everhour)$/]",
          message: 'Decide by a connection\'s capabilities (useConnections), not by its service.',
        },
      ],
    },
  },
])
