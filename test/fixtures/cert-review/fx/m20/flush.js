const n = Number(process.argv[2] ?? 3000000); process.stdout.write(Buffer.alloc(n, 0x61)); process.stderr.write('E-tail\n'); process.exit(0);
