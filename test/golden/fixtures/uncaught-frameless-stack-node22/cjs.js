const e = new Error("file");
e.stack = "replaced";
e.code = "F";
throw e;
