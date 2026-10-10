export function moduleNotFound(request, requireStack = []) {
  const err = new Error(`Cannot find module '${request}'`);
  err.code = 'MODULE_NOT_FOUND';
  err.requireStack = requireStack;
  return err;
}

export function errRequireEsm(filename) {
  const err = new Error(
    `require() of ES Module ${filename} not supported. Use import() instead.`
  );
  err.code = 'ERR_REQUIRE_ESM';
  return err;
}

export function packagePathNotExported(subpath, packageJsonUrl) {
  const err = new Error(
    `Package subpath '${subpath}' is not defined by "exports" in ${packageJsonUrl}`
  );
  err.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  return err;
}
