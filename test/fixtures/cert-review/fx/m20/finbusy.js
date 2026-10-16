try { process.exit(0); } finally { const t = Date.now(); while (Date.now() - t < 3000); }
