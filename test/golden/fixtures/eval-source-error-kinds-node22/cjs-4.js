function f() {
	const e = new RangeError("m"); e.stack; throw e
}
f()
