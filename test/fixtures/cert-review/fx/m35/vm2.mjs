import vm from 'node:vm';
const ctx = vm.createContext({});
const t = async (l, f) => { try { console.log(l, await f()); } catch (e) { console.log(l, 'error', e.code ?? e.name, String(e.message).slice(0, 70)); } };
await t('ctx no option', () => vm.runInContext('import("node:url").then((m) => typeof m.URL)', ctx));
await t('ctx main loader', () => vm.runInContext('import("node:url").then((m) => typeof m.URL)', ctx, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }));
await t('newctx main loader', () => vm.runInNewContext('import("node:os").then((m) => typeof m.EOL)', {}, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }));
await t('Script in ctx', () => new vm.Script('import("node:os").then((m) => typeof m.EOL)', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInContext(ctx));
await t('this-ctx main loader', () => vm.runInThisContext('import("node:os").then((m) => typeof m.EOL)', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }));
