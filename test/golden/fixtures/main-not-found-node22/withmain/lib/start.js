const shown = (s) => String(s).split(process.cwd()).join('<cwd>');
console.log('ran', shown(__filename), 'argv[1]', shown(process.argv[1]), 'main', require.main === module);
