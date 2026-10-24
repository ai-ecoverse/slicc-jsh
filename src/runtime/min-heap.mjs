export function createMinHeap(before) {
  const items = [];
  const up = (i) => {
    const item = items[i];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(item, items[parent])) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = item;
  };
  const down = (i) => {
    const item = items[i];
    for (;;) {
      let child = 2 * i + 1;
      if (child >= items.length) break;
      if (child + 1 < items.length && before(items[child + 1], items[child])) child++;
      if (!before(items[child], item)) break;
      items[i] = items[child];
      i = child;
    }
    items[i] = item;
  };
  return {
    get size() {
      return items.length;
    },
    push(item) {
      items.push(item);
      up(items.length - 1);
    },
    top(valid) {
      while (items.length > 0 && !valid(items[0])) {
        const last = items.pop();
        if (items.length > 0) {
          items[0] = last;
          down(0);
        }
      }
      return items[0];
    },
    keep(valid) {
      const live = items.filter(valid);
      items.length = 0;
      for (const item of live) items.push(item);
      for (let i = (items.length >> 1) - 1; i >= 0; i--) down(i);
    },
    drain() {
      return items.splice(0);
    },
  };
}
