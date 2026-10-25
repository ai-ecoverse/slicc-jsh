const f = (o, e) => e;
throw f({ code: "E1" }, new TypeError("c"));
