try { process.exit(0); } finally { require('fs').writeFileSync(process.argv[2], 'the finally ran'); const t = Date.now(); while (Date.now() - t < 3000); }
