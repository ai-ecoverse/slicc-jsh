const e = new Error('with props');
e.code = 'E_COMPARE';
e.detail = { n: 1 };
throw e;
