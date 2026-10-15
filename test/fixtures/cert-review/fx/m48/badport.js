(async () => {
  for (const u of ['http://127.0.0.1:1/', 'http://127.0.0.1:6000/', 'http://127.0.0.1:10080/', 'http://localhost:6665/', 'http://127.0.0.1:65536/']) {
    try { const r = await fetch(u); console.log(u, 'status', r.status); } catch (e) { console.log(u, e.name, e.message, e.cause ? `${e.cause.name}: ${e.cause.message}` : '', e.cause?.code ?? ''); }
  }
})();
