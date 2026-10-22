/**
 * The skills corpus that uses `sliccy:browser` (ai-ecoverse/skills#492; the
 * list in ai-ecoverse/slicc-jsh#73): each script's `--help` in the kernel jsh
 * against the harness browser, and, where it is safe and needs no
 * credentials, one real call: a read command whose first step looks for the
 * service's tab (`findTab`) over CDP and stops when there's none. Every run
 * is compared with the host jsh on the same browser.
 *
 * The scripts come from ai-ecoverse/skills at SKILLS_REF, fetched into
 * node_modules/.cache, or from SKILLS_DIR (a checkout).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '../browser/chrome.mjs';
import { hostJshWith } from '../browser/host.mjs';
import { booted, installJshAndBrowser, packJsh, SLICCY_BROWSER } from '../browser/kernel.mjs';

export const SKILLS_REF = '99f93d467457a7bac3b6666593cafbbc86e8a95d';

/** The 37 scripts of ai-ecoverse/slicc-jsh#73, under skills/. */
export const CORPUS = [
  'aem-edge-functions/scripts/aem-edge-functions.jsh',
  'aem/scripts/aem-ext.jsh',
  'apple-music/scripts/apple-music.jsh',
  'bb/scripts/bb.jsh',
  'cloudflare/scripts/wrangler-ext.jsh',
  'cloudflare/scripts/wrangler.jsh',
  'concur/scripts/concur.jsh',
  'cosmos/scripts/cosmos.jsh',
  'fastly/scripts/fastly.jsh',
  'fluffyjaws/scripts/fj.jsh',
  'gcloud/scripts/gcloud-ext.jsh',
  'icloud/scripts/icloud.jsh',
  'immobilienscout24/scripts/immobilienscout24.jsh',
  'intent/scripts/intent-arm.jsh',
  'intent/scripts/intent.jsh',
  'jira/jira.jsh',
  'linkedin/scripts/linkedin.jsh',
  'metaculus/scripts/metaculus-ext.jsh',
  'navan/scripts/navan.jsh',
  'oryx/scripts/oryx.jsh',
  'outlook/scripts/outlook.jsh',
  'printful/scripts/printful.jsh',
  'seo/scripts/search-console.jsh',
  'servicenow/scripts/servicenow.jsh',
  'sessionize/scripts/sessionize.jsh',
  'sharepoint/scripts/sharepoint.jsh',
  'signal/scripts/signal.jsh',
  'slack/scripts/slack-ext.jsh',
  'slack/scripts/slack-support.jsh',
  'slack/scripts/slack.jsh',
  'speck/speck.jsh',
  'strava/scripts/strava.jsh',
  'suno/scripts/suno.jsh',
  'swarm/scripts/swarm.jsh',
  'teams/scripts/teams.jsh',
  'tiktok/scripts/tiktok.jsh',
  'wunderflats/scripts/wunderflats.jsh',
];

/**
 * Real calls: read commands that only look for an open tab of the service
 * (`findTab`, never `ensureTab`, so nothing navigates to the real site),
 * with no tab open there: each must reach the browser and stop cleanly.
 * Not here: signal (it drives the tab with playwright-cli, a command only
 * the kernel has) and metaculus-ext (`cp` asks the public API, not a tab).
 */
export const CALLS = {
  'cosmos/scripts/cosmos.jsh': ['me'],
  'jira/jira.jsh': ['detect'],
  'strava/scripts/strava.jsh': ['me'],
  'wunderflats/scripts/wunderflats.jsh': ['me'],
  'swarm/scripts/swarm.jsh': ['checkins'],
  'tiktok/scripts/tiktok.jsh': ['whoami'],
  'sessionize/scripts/sessionize.jsh': ['sessions'],
  'seo/scripts/search-console.jsh': ['verify'],
  'icloud/scripts/icloud.jsh': ['calendars'],
  'outlook/scripts/outlook.jsh': ['mail'],
  'suno/scripts/suno.jsh': ['feed'],
  'slack/scripts/slack.jsh': ['workspaces'],
  'sharepoint/scripts/sharepoint.jsh': ['sites', '--search', 'x'],
};

const cache = fileURLToPath(new URL(`../../node_modules/.cache/slicc-jsh-skills/${SKILLS_REF}/`, import.meta.url));

function skills() {
  if (process.env.SKILLS_DIR) return process.env.SKILLS_DIR;
  if (!existsSync(join(cache, 'skills'))) {
    mkdirSync(cache, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: cache, stdio: 'pipe' });
    git('init', '-q');
    git('fetch', '-q', '--depth', '1', 'https://github.com/ai-ecoverse/skills.git', SKILLS_REF);
    git('checkout', '-q', 'FETCH_HEAD');
  }
  return cache;
}

/** A skill's files (under 1 MB each), as [path relative to skills/, bytes]. */
function skillFiles(base, skill) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.size < 1024 * 1024) out.push([relative(base, path), readFileSync(path)]);
    }
  };
  walk(join(base, skill));
  return out;
}

const pack = mkdtempSync(join(tmpdir(), 'jsh-corpus-pack-'));
let chrome;
let host;
let tgz;
let base;

before(async () => {
  base = join(skills(), 'skills');
  tgz = packJsh(pack);
  chrome = await launch({ pack: `${pack}/` });
  host = hostJshWith(SLICCY_BROWSER);
}, { timeout: 900_000 });

after(async () => {
  await chrome?.close();
  host?.close();
  rmSync(pack, { recursive: true, force: true });
});

const KERNEL_SKILLS = '/home/skills';

/** What may differ between the two runs: where the skills are. */
const normal = (text, at) => text.replaceAll(at, '$SKILLS');

test('the sliccy:browser corpus in the kernel jsh, as on the host jsh', { timeout: 900_000 }, async (t) => {
  const k = await booted(chrome, t);
  await installJshAndBrowser(k, chrome, tgz);

  // The skills, as files the user has: written by a kernel process.
  const files = [...new Set(CORPUS.map((script) => script.split('/')[0]))].flatMap((skill) =>
    skillFiles(base, skill)
  );
  const payload = JSON.stringify(files.map(([path, bytes]) => [path, bytes.toString('base64')]));
  const wrote = await k.run(
    [
      'node',
      '-e',
      `const fs = require('fs'), path = require('path');
let text = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (text += c)).on('end', () => {
  for (const [p, b] of JSON.parse(text)) {
    const at = path.join(${JSON.stringify(KERNEL_SKILLS)}, p);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, Buffer.from(b, 'base64'));
  }
  console.log('wrote', JSON.parse(text).length);
});`,
    ],
    { stdin: payload }
  );
  assert.equal(wrote.status, 0, wrote.stderr);

  const both = async (script, args) => {
    const name = script.split('/').pop();
    const kernel = await k.run(['timeout', '60', 'jsh', name, ...args], {
      cwd: dirname(`${KERNEL_SKILLS}/${script}`),
    });
    const onHost = await host.run([name, ...args], {
      cwd: dirname(join(base, script)),
      env: { SLICC_CDP_URL: chrome.browser },
    });
    return {
      kernel: { ...kernel, stdout: normal(kernel.stdout, KERNEL_SKILLS), stderr: normal(kernel.stderr, KERNEL_SKILLS) },
      host: { ...onHost, stdout: normal(onHost.stdout, base), stderr: normal(onHost.stderr, base) },
    };
  };

  for (const script of CORPUS) {
    await t.test(`${script} --help`, async () => {
      const { kernel, host: onHost } = await both(script, ['--help']);
      assert.notEqual(kernel.status, 124, `${script} --help did not end`);
      assert.doesNotMatch(kernel.stderr, /sliccy:browser|Cannot find module/);
      assert.deepEqual(kernel, onHost);
    });
  }

  for (const [script, args] of Object.entries(CALLS)) {
    await t.test(`${script} ${args.join(' ')} (no tab open: findTab over CDP)`, async () => {
      const before = await k.page.evaluate(() => window.cdpOpened);
      const { kernel, host: onHost } = await both(script, args);
      assert.notEqual(kernel.status, 124, `${script} ${args.join(' ')} did not end`);
      assert.ok((await k.page.evaluate(() => window.cdpOpened)) > before, 'it reached the browser over CDP');
      assert.doesNotMatch(kernel.stdout + kernel.stderr, /CDP connection failed|no debugger is connected/);
      assert.deepEqual(kernel, onHost);
    });
  }
  assert.equal(k.sockets.size, 0, 'every CDP connection the kernel opened is closed');
});
