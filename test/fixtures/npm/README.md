# Vendored npm ESM fixtures

Real published package files used by `test/integration/esm.test.mjs`.
Keep byte-identical to the vendoring snapshot (Renovate ignores `test/fixtures/**`).

| Fixture | Upstream | Notes |
|---------|----------|--------|
| `chalk/` | [chalk@5.4.1](https://www.npmjs.com/package/chalk/v/5.4.1) (MIT) | Sources verbatim from the npm tarball. `package.json` `#supports-color` import is pinned to the published browser build so the sandbox need not implement `node:tty`. |
| `esm-reexports/` | [unicorn-magic@0.3.0](https://www.npmjs.com/package/unicorn-magic) `default.js` + [lodash-es@4.17.21](https://www.npmjs.com/package/lodash-es) `isArray.js` | `index.js` is the two published patterns `export * from` and `export { default as X } from` over those files. Licenses in `LICENSE.*`. |
