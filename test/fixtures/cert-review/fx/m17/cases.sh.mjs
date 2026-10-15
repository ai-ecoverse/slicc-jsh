export default [
  { name: 'lines', cmd: 'node lines.js', stdin: 'one\ntwo\n\nlast-no-newline' },
  { name: 'lines-empty', cmd: 'node lines.js < /dev/null' },
  { name: 'lines-crlf', cmd: 'node lines-crlf.js', stdin: 'a\r\nb\rc\n\r\nd' },
  { name: 'lines-big', cmd: 'head -c 2000000 /dev/zero | tr "\\0" "a" | fold -w 100 | node iter.js' },
  { name: 'iter', cmd: 'node iter.js', stdin: 'x\ny\nz\n' },
  { name: 'question-pipe', cmd: 'node question.js', stdin: 'bob\n42\n' },
  { name: 'question-eof', cmd: 'node question.js', stdin: 'only-one' },
  { name: 'promises-abort', cmd: '(echo alice; sleep 1) | node promises.js' },
  { name: 'prompt', cmd: 'node prompt.js', stdin: 'a\nb\nquit\n' },
  { name: 'prompt-eof', cmd: 'node prompt.js', stdin: 'a\n' },
  { name: 'api', cmd: 'node api.js' },
];
