export function moduleNotFound(request, requireStack = []) {
  let message = `Cannot find module '${request}'`;
  if (requireStack?.length) {
    message += `\nRequire stack:\n${requireStack.map((s) => `- ${s}`).join('\n')}\n`;
  }
  const err = new Error(message);
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
