try { throw new Error('boom'); } catch (e) { console.log('in catch'); process.exit(3); console.log('after exit'); } finally { console.log('finally runs?'); }
console.log('after try');
