console.log(JSON.stringify({ getuid: process.getuid(), geteuid: process.geteuid(), getgid: process.getgid(), groups: Array.isArray(process.getgroups?.()) }));
