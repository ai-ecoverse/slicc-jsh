console.log('fetching');
try { await fetch('http://10.255.255.1:81/'); console.log('fetched?'); } catch (e) { console.log('fetch failed', e.message); }
