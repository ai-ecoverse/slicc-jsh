;; A preview1 program for node:wasi under users: enforce: argv[1] is an
;; operation on argv[2], a path in its preopen (fd 3): "r" opens it to read,
;; "c" creates it (O_CREAT) and writes "x" to it, "u" unlinks it. It exits
;; with the WASI errno (0 when it worked).
(module
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file" (func $path_unlink_file (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 900) "x")

  ;; The length of the NUL-terminated string at ptr.
  (func $strlen (param $ptr i32) (result i32)
    (local $n i32)
    (block $done
      (loop $next
        (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $ptr) (local.get $n)))))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $next)))
    (local.get $n))

  (func (export "_start")
    (local $op i32) (local $path i32) (local $len i32) (local $errno i32)
    ;; argv pointers at 1000, their strings at 2000.
    (drop (call $args_sizes_get (i32.const 960) (i32.const 964)))
    (drop (call $args_get (i32.const 1000) (i32.const 2000)))
    (local.set $op (i32.load8_u (i32.load (i32.const 1004))))
    (local.set $path (i32.load (i32.const 1008)))
    (local.set $len (call $strlen (local.get $path)))
    (if (i32.eq (local.get $op) (i32.const 117)) ;; 'u'
      (then (local.set $errno (call $path_unlink_file (i32.const 3) (local.get $path) (local.get $len))))
      (else
        (if (i32.eq (local.get $op) (i32.const 99)) ;; 'c': O_CREAT, FD_WRITE
          (then
            (local.set $errno (call $path_open (i32.const 3) (i32.const 0) (local.get $path) (local.get $len) (i32.const 1) (i64.const 64) (i64.const 0) (i32.const 0) (i32.const 968)))
            (if (i32.eqz (local.get $errno))
              (then
                (i32.store (i32.const 920) (i32.const 900))
                (i32.store (i32.const 924) (i32.const 1))
                (local.set $errno (call $fd_write (i32.load (i32.const 968)) (i32.const 920) (i32.const 1) (i32.const 928))))))
          (else ;; 'r': FD_READ
            (local.set $errno (call $path_open (i32.const 3) (i32.const 0) (local.get $path) (local.get $len) (i32.const 0) (i64.const 2) (i64.const 0) (i32.const 0) (i32.const 968)))))))
    (call $proc_exit (local.get $errno))))
