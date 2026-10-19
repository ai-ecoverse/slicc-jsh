;; A reactor: _initialize, no _start. It counts how often _initialize ran.
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (global $inits (mut i32) (i32.const 0))
  (func (export "_initialize") (global.set $inits (i32.add (global.get $inits) (i32.const 1))))
  (func (export "inits") (result i32) (global.get $inits)))
