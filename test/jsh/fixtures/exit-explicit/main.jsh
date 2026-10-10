setTimeout(() => console.log('never'), 30);
console.log('before');
try {
  process.exit(7);
} finally {
  // In v6 process.exit threw an exception user code could catch; here it is Node's exit.
}
console.log('after');
