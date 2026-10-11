const data = await process.stdin.read();
process.stdout.write(`await read(): ${JSON.stringify(data)}\n`);
