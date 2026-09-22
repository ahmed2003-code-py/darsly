import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

/**
 * Lint, introduced deliberately quietly.
 *
 * This repository ran for 82 migrations with no linter at all, so every
 * convention in it is upheld by hand. Switching one on at `error` would paint
 * the whole tree red and the only rational response would be a mass
 * auto-format — which destroys `git blame` on 100k lines and reviews as one
 * unreadable commit.
 *
 * So: every rule here is `warn`. CI reports the count and never fails on it.
 * The rules are promoted to `error` one at a time, each with its own commit
 * that fixes the violations it introduces.
 *
 * The rule set is narrow on purpose — three rules that catch real defects
 * rather than style opinions. Formatting is Prettier's job, and
 * `eslint-config-prettier` is last so ESLint never argues with it.
 */
/**
 * Force every rule in a flat-config array down to `warn`.
 *
 * The shared presets below ship most of their rules at `error`, and on a tree
 * this size that means CI is red on the commit that introduces linting — which
 * is how a linter gets disabled again a week later. Rather than drop the
 * presets (they find genuine defects: implied eval, unsafe enum comparison),
 * every severity is rewritten once, here, so the findings are all visible and
 * none of them block. Promoting a rule back to `error` is then a one-line,
 * one-rule decision in the block below.
 */
function allWarn(configs) {
  return configs.map((config) =>
    config.rules
      ? {
          ...config,
          rules: Object.fromEntries(
            Object.entries(config.rules).map(([rule, setting]) => {
              const value = Array.isArray(setting) ? [...setting] : [setting];
              if (value[0] === 'error' || value[0] === 2) value[0] = 'warn';
              return [rule, value.length === 1 ? value[0] : value];
            }),
          ),
        }
      : config,
  );
}

export default allWarn(
  tseslint.config(
  {
    // Nothing generated, vendored, built, or outside the TypeScript apps.
    // `scripts/` holds 60+ standalone audit tools that are run by hand and are
    // not part of any tsconfig; linting them is its own piece of work.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'android/**',
      'scripts/**',
      'apps/api/prisma/**',
      'apps/web/public/**',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts',
    ],
  },

  js.configs.recommended,

  // Type-aware linting, scoped to the three TypeScript source trees. It needs
  // a real type-checker, which is why it is not applied to loose files: a file
  // no tsconfig owns makes the parser throw rather than skip.
  {
    files: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'packages/shared-types/src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The three that catch defects rather than taste.
      //
      // no-floating-promises is the one that matters most here: the codebase
      // has real fire-and-forget calls (see ARCHITECTURE_REVIEW.md §11 #2,
      // video-processing.service.ts), and an un-awaited promise in a NestJS
      // request handler is a silently swallowed failure.
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Everything else recommendedTypeChecked would assert is off for now.
      // These are the noisy-but-not-wrong ones; they come back individually,
      // each with the commit that cleans up after it.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-unused-vars': 'off', // superseded by the TypeScript-aware version above
    },
  },

  /**
   * React Hooks rules, for a reason that is not "a React app should have them".
   *
   * The web source already carries 21 `// eslint-disable-next-line
   * react-hooks/exhaustive-deps` comments, written against a plugin nobody
   * ever installed. ESLint treats a disable comment naming an unknown rule as
   * a hard error, so without this the very first lint run reports 21 errors
   * that say nothing about the code. Installing the real plugin is what those
   * comments were always assuming, and it means a genuine stale-closure bug in
   * a dependency array is now caught instead of waved through.
   */
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Specs assert on shapes the type system cannot see, so `any` there is a
  // tool rather than a smell.
  {
    files: ['**/*.spec.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // Last: turns off every rule Prettier already decides.
  prettier,
  ),
);
