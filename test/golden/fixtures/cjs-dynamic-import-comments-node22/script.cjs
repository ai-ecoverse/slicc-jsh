const run = async () => {
  const a = await import /* between */ ('./target.mjs');
  const b = await import // to the end of the line
  ('./target.mjs');
  const c = await import
  ('./target.mjs');
  console.log(a.default, b === a, c === a);
  console.log("import (", 'important', `imports(${1})`);
};
run();
