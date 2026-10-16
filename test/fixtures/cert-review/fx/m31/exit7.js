process.on('uncaughtException', () => { throw new Error('thrown from the handler'); });
setTimeout(() => { throw new Error('first'); }, 1);
