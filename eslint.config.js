import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/*
 * One flat config for every workspace.
 *
 * It lives at the root rather than per package because the alternative is
 * duplicating this file and its five devDependencies into @barkeep/core and
 * @barkeep/mcp, which then drift. Flat config resolves plugins from where the
 * config file is, so a single root config lints the whole tree with one
 * install.
 *
 * The React rules are scoped to the web app: they are meaningless in a Node
 * MCP server, and applied globally react-refresh/only-export-components fires
 * on every module that exports more than one value.
 */
export default defineConfig([
  globalIgnores([
    '**/dist',
    '**/node_modules',
    'target',
    'packages/web/build/license-overrides',
  ]),

  // Everything: base JS + TypeScript rules.
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },

  // The browser app.
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },

  // Node-side code: the MCP server, the build tooling and the scripts.
  {
    files: [
      'packages/mcp-server/**/*.{ts,mjs}',
      'packages/core/**/*.ts',
      'packages/web/build/**/*.ts',
      'packages/web/scripts/**/*.{ts,mjs}',
      'scripts/**/*.{ts,mjs}',
      'eslint.config.js',
      '**/vite.config.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
])
