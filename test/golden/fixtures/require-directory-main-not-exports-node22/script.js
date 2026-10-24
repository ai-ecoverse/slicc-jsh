const path = require('path');
for (const request of ['./dir', './only-exports', `${__dirname}/dir`, 'with-exports', 'plain/sub']) {
  console.log(request.startsWith('/') ? '<abs>/dir' : request, '->', require(request), path.relative(__dirname, require.resolve(request)));
}
