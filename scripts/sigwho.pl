#!/usr/bin/perl
# sigwho.pl LOG -- cmd...: runs cmd in this process group, and logs to LOG who
# sends the group SIGINT, SIGTERM, SIGHUP or SIGQUIT (siginfo's si_pid, and
# that process's command line while it is still there), for
# ai-ecoverse/slicc-jsh#250: a host SIGINT reached the suites' group on the
# bench pool, and the bench has no strace. The command gets the signal too
# (it is in the group); the exit status is the command's (128 + n when a
# signal ended it).
use strict; use warnings; use POSIX ();
my $log = shift @ARGV; shift @ARGV if @ARGV && $ARGV[0] eq '--';
sub note { my ($name, $info) = @_; my $pid = $info && $info->{pid} // '?'; my $code = $info && $info->{code} // '?';
  my $cmd = ''; if ($pid =~ /^\d+$/ && open(my $f, '<', "/proc/$pid/cmdline")) { local $/; $cmd = <$f> // ''; $cmd =~ s/\0/ /g; close $f }
  if (!$cmd && $pid =~ /^\d+$/) { $cmd = `ps -o pid=,ppid=,pgid=,command= -p $pid 2>/dev/null`; chomp $cmd }
  if (open(my $o, '>>', $log)) { printf $o "%s %s from pid %s (si_code %s): %s\n", scalar(localtime), $name, $pid, $code, $cmd; close $o } }
my $child;
for my $s (qw(INT TERM HUP QUIT)) {
  POSIX::sigaction(eval "POSIX::SIG$s()", POSIX::SigAction->new(sub { note("SIG$s", $_[1]) }, POSIX::SigSet->new, POSIX::SA_SIGINFO()));
}
$child = fork(); die "fork: $!" unless defined $child;
if ($child == 0) { $SIG{$_} = 'DEFAULT' for qw(INT TERM HUP QUIT); exec @ARGV or die "exec: $!" }
my $r; do { $r = waitpid($child, 0) } while ($r == -1 && $!{EINTR});
my $st = $?; exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
