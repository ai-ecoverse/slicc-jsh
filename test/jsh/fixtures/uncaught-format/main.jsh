setTimeout(() => console.log('never'), 30);
const err = new Error('outer', { cause: new Error('inner') });
err.code = 'E_JSH';
throw err;
