const skill = require('sliccy:skill');
const fs = require('fs');
const path = require('path');
const rel = (p) => path.relative(process.cwd(), p) || '.';
console.log(Object.keys(skill).sort().join(','));
console.log('dir', rel(skill.dir), 'root', rel(skill.root), 'refs', rel(skill.refs), 'assets', rel(skill.assets));
console.log(fs.readFileSync(path.join(skill.refs, 'r.md'), 'utf8').trim());
console.log(JSON.stringify(await skill.config()));
