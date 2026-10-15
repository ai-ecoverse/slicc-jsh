try { require('fs').access('/tmp'); } catch (e) { console.log(e.name, e.code, e.message.slice(0, 120)); }
