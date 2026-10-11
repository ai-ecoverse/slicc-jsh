function where() {
  return new Error('x').stack.split('\n')[1].trim();
}
console.log(where().replace(/^at where \(|\)$/g, ''));
