const sys = require('sys'); const util = require('util');
console.log(sys === util, typeof sys.inspect, sys.format('%s=%d', 'a', 1), require('node:sys') === sys);
