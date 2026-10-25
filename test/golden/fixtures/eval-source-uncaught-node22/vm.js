const vm = require("vm");
vm.runInThisContext("\n  null.x", { filename: "a.vm" });
