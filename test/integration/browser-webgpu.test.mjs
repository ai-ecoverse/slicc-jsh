/**
 * WebGPU work in flight keeps a kernel jsh program alive, as pending I/O
 * does in Node (ai-ecoverse/slicc-ortllama#24): a program that submits slow
 * GPU work and then awaits `mapAsync` (or `onSubmittedWorkDone`) must see it
 * settle, not exit 13 with "Detected unsettled top-level await".
 *
 * Real WebGPU, in the harness Chromium's process worker: the platform's GPU
 * where there is one (Metal on a Mac), SwiftShader's Vulkan on Linux.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from '../browser/chrome.mjs';
import { booted, installJsh, packJsh } from '../browser/kernel.mjs';

// Chrome's software WebGPU on a runner without a GPU.
const WEBGPU =
  process.platform === 'linux'
    ? [
        '--enable-unsafe-webgpu',
        '--enable-unsafe-swiftshader',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
        '--use-webgpu-adapter=swiftshader',
        '--disable-vulkan-surface',
      ]
    : [];

const pack = mkdtempSync(join(tmpdir(), 'jsh-webgpu-pack-'));
let chrome;
let tgz;

before(async () => {
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/`, args: WEBGPU });
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  rmSync(pack, { recursive: true, force: true });
});

/**
 * Sizes the GPU work to about 400 ms on this GPU (while an interval holds the
 * program, so the sizing never depends on the fix), drops the interval, then
 * submits that work and awaits it with nothing else keeping the loop alive.
 * `slow` says the wait outlived the loop's few-turn grace for a pending
 * entry, so without the fix the program would have ended first.
 */
const GPU_PROGRAM = `const mode = process.argv[2];
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  console.log('no adapter');
  process.exit(2);
}
const device = await adapter.requestDevice();
// Pending for the device's whole life: it must not hold the program.
device.lost.then(() => {});
const N = 65536;
const shader = device.createShaderModule({
  code: \`@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@group(0) @binding(1) var<uniform> n: u32;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  var x = id.x;
  for (var i = 0u; i < n; i++) { x = x * 1664525u + 1013904223u; }
  out[id.x] = x | 1u;
}\`,
});
const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
const out = device.createBuffer({ size: N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const params = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const read = device.createBuffer({ size: N * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: out } },
    { binding: 1, resource: { buffer: params } },
  ],
});
const submit = (iterations, copy) => {
  device.queue.writeBuffer(params, 0, new Uint32Array([iterations]));
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(N / 64);
  pass.end();
  if (copy) encoder.copyBufferToBuffer(out, 0, read, 0, N * 4);
  device.queue.submit([encoder.finish()]);
};

const hold = setInterval(() => {}, 1000);
// The first submit compiles the pipeline: not part of the sizing.
submit(1, false);
await device.queue.onSubmittedWorkDone();
let iterations = 1024;
for (;;) {
  const started = performance.now();
  submit(iterations, false);
  await device.queue.onSubmittedWorkDone();
  const took = performance.now() - started;
  if (took >= 50 || iterations >= 1 << 24) {
    iterations = Math.max(1, Math.min(1 << 26, Math.round((iterations * 400) / Math.max(took, 1))));
    break;
  }
  iterations *= 4;
}
clearInterval(hold);

const started = performance.now();
submit(iterations, mode === 'map');
console.log('submitted');
if (mode === 'map') {
  await read.mapAsync(GPUMapMode.READ);
  const first = new Uint32Array(read.getMappedRange())[0];
  console.log('mapped', first !== 0);
  read.unmap();
} else {
  await device.queue.onSubmittedWorkDone();
  console.log('done');
}
console.log('slow', performance.now() - started >= 100);
`;

// The repro of ai-ecoverse/slicc-ortllama#24 is an ES module (exit 13 and
// the unsettled top-level await warning without the fix); a `.jsh` body
// ends quietly instead (exit 0, the last lines missing). Both, both waits.
const RUNS = [
  ['node', '/home/t/gpu.mjs'],
  ['jsh', '/home/t/gpu.jsh'],
];
const WAITS = {
  map: ['await read.mapAsync() after slow work', 'submitted\nmapped true\nslow true\n'],
  done: ['await queue.onSubmittedWorkDone() after slow work', 'submitted\ndone\nslow true\n'],
};

test('pending WebGPU work keeps a kernel program alive', { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t, { cdp: false });
  await installJsh(k, chrome, tgz);
  await k.write('/home/t/gpu.mjs', GPU_PROGRAM);
  await k.write('/home/t/gpu.jsh', GPU_PROGRAM);

  for (const [command, file] of RUNS) {
    for (const [mode, [label, stdout]] of Object.entries(WAITS)) {
      await t.test(`${command} ${file.split('/').pop()}: ${label} settles, exit 0`, async () => {
        const r = await k.run(['timeout', '120', command, file, mode]);
        assert.deepEqual(r, { status: 0, stdout, stderr: '' });
      });
    }
  }

  assert.deepEqual(k.page.errors, []);
});
