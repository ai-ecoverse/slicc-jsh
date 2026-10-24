import { join } from "path";
const k = () => join("a") + eval("null.shift");
k();
