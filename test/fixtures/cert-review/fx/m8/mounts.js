try { console.log(require('fs').readFileSync('/proc/mounts', 'utf8')); } catch (e) { console.log(e.code); }
