# Agents

## Unit tests

Run `npm ci` once so `prepare` installs the lefthook pre-commit hook.

Write throwaway unit tests in `test/unit/**/*.test.mjs` that cover 100% of the lines you change in `src/`. The hook runs `npm run test:unit` and refuses a commit whose staged `src/` lines are not all covered. Never commit unit tests: `test/unit/` is gitignored, the hook refuses a force-added one, and they go away with the worktree.

Unit tests do not replace the committed tests. A change in behaviour still needs its integration test or golden under `test/`, and for a fix that test must fail on the old code.
