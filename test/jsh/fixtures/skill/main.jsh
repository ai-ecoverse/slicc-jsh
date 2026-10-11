const skill = require('sliccy:skill');
const path = require('path');
console.log(skill.dir === __dirname, path.basename(skill.refs), path.basename(skill.assets));
console.log(JSON.stringify(await skill.config()));
console.log(JSON.stringify(await skill.config({ a: 1 })));
console.log(JSON.stringify(await skill.config({ b: 2 })));
console.log(JSON.stringify(require('fs').readFileSync(path.join(__dirname, '.config'), 'utf8')));
try {
  await skill.token('adobe');
} catch (err) {
  console.log(err.message);
}
