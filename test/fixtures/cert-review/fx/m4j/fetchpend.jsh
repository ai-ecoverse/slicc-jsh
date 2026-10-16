console.log('fetching');
const r = fetch('http://10.255.255.1:81/').then(() => console.log('fetched?'), (e) => console.log('fetch failed', e.message));
