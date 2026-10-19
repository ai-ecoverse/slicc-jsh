;; A preview1 program for node:wasi's golden: it prints its args and its
;; environment (one per line), its preopen's name, the file data.txt read
;; through that preopen, a line on stderr, then exits with the errno of
;; opening missing.txt (ENOENT, 44).
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get" (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_get" (func $fd_prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name" (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 7000) "data.txt")
  (data (i32.const 7016) "missing.txt")
  (data (i32.const 7032) "on stderr\n")
  (data (i32.const 7048) "\n")

  ;; Write len bytes at ptr to fd (iovec at 64, written count at 72).
  (func $write (param $fd i32) (param $ptr i32) (param $len i32)
    (i32.store (i32.const 64) (local.get $ptr))
    (i32.store (i32.const 68) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const 64) (i32.const 1) (i32.const 72))))

  ;; NULs to newlines, in place.
  (func $lines (param $ptr i32) (param $len i32)
    (local $end i32)
    (local.set $end (i32.add (local.get $ptr) (local.get $len)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $ptr) (local.get $end)))
        (if (i32.eqz (i32.load8_u (local.get $ptr)))
          (then (i32.store8 (local.get $ptr) (i32.const 10))))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
        (br $next))))

  (func (export "_start")
    ;; args: count at 0, size at 4, pointers at 1024, strings at 2048
    (drop (call $args_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $args_get (i32.const 1024) (i32.const 2048)))
    (call $lines (i32.const 2048) (i32.load (i32.const 4)))
    (call $write (i32.const 1) (i32.const 2048) (i32.load (i32.const 4)))
    ;; environ: the same, pointers at 3072, strings at 4096
    (drop (call $environ_sizes_get (i32.const 0) (i32.const 4)))
    (drop (call $environ_get (i32.const 3072) (i32.const 4096)))
    (call $lines (i32.const 4096) (i32.load (i32.const 4)))
    (call $write (i32.const 1) (i32.const 4096) (i32.load (i32.const 4)))
    ;; the preopen at fd 3: its name's length at 12, the name at 5120
    (drop (call $fd_prestat_get (i32.const 3) (i32.const 8)))
    (drop (call $fd_prestat_dir_name (i32.const 3) (i32.const 5120) (i32.load (i32.const 12))))
    (call $write (i32.const 1) (i32.const 5120) (i32.load (i32.const 12)))
    (call $write (i32.const 1) (i32.const 7048) (i32.const 1))
    ;; data.txt through the preopen, with the fd_read right; its fd at 16
    (drop (call $path_open (i32.const 3) (i32.const 0) (i32.const 7000) (i32.const 8) (i32.const 0)
      (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 16)))
    (i32.store (i32.const 24) (i32.const 6144))
    (i32.store (i32.const 28) (i32.const 512))
    (drop (call $fd_read (i32.load (i32.const 16)) (i32.const 24) (i32.const 1) (i32.const 32)))
    (call $write (i32.const 1) (i32.const 6144) (i32.load (i32.const 32)))
    (drop (call $fd_close (i32.load (i32.const 16))))
    (call $write (i32.const 2) (i32.const 7032) (i32.const 10))
    (call $proc_exit (call $path_open (i32.const 3) (i32.const 0) (i32.const 7016) (i32.const 11) (i32.const 0)
      (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 16))))
)
