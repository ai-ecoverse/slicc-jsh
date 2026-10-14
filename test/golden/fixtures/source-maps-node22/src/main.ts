import { run } from './orig';

console.log(run([{ x: 1, y: 2 }]));
try {
  run([{ x: -1, y: 0 }]);
} catch (e) {
  console.log((e as Error).stack);
}
run([{ x: -2, y: 0 }]);
