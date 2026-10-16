#!/usr/bin/env node
/**
 * The release tag job's last step: semantic-release runs with
 * continue-on-error so that a failure after it tagged still lets the publish
 * job publish that tag, but the tag job itself never ends green when
 * semantic-release failed. Prints the outcome and exits 1 when
 * SEMANTIC_RELEASE (the step's outcome) is not success.
 *
 * Usage: SEMANTIC_RELEASE=<outcome> node scripts/release-outcome.mjs
 */
import { execFileSync } from 'node:child_process';

const outcome = process.env.SEMANTIC_RELEASE ?? '';
const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { encoding: 'utf8' })
  .split('\n')
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
if (outcome === 'success') {
  console.log(tags.length ? `semantic-release tagged ${tags.join(', ')}` : 'semantic-release: nothing to release');
  process.exit(0);
}
console.log(
  tags.length
    ? `semantic-release ended ${outcome || 'unknown'} after tagging ${tags.join(', ')}: the publish job still publishes it, but this job fails so the failure is seen`
    : `semantic-release ended ${outcome || 'unknown'} before tagging: nothing was released`
);
process.exit(1);
