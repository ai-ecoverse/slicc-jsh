setTimeout(() => { Promise.reject(new Error('rejected in timer')); }, 1);
