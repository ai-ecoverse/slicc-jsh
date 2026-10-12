console.log(JSON.stringify(process.argv.parseFlags()));
console.log(JSON.stringify(process.argv.parseFlags({ boolean: ['v'] })));
