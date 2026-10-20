import shared from '@ai-ecoverse/slicc-shared-web/mcr.config.mjs';

// The shared `all.filter` glob is matched against absolute paths, and `**`
// skips dot-directories, so in a worktree under ~/.bb/ no untested src/ file
// reached the lcov and diff coverage passed on a change with no unit test.
// Only the lcov is written: diff-cover names the uncovered changed lines, and
// a console table would list every src/ file.
export default {
  ...shared,
  reports: ['lcovonly'],
  all: { ...shared.all, filter: (file) => /\.(m?js|ts)$/.test(file) },
};
