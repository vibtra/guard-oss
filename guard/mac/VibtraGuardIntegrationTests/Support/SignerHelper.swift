// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import Foundation

enum SignerHelper: String {
    case relay, early, wrong
    case forkEcho = "fork-echo"
    case forkRequest = "fork-request"
    case execEcho = "exec-echo"

    static let perl = URL(fileURLWithPath: "/usr/bin/perl")

    func arguments(socket: String) -> [String] { ["-e", Self.script, socket, rawValue] }

    private static let script = #"""
use strict;
use warnings;
use Socket;
use IO::Select;
use POSIX ();

my ($path, $mode) = @ARGV;
socket(my $s, AF_UNIX, SOCK_STREAM, 0) or die "socket: $!";
connect($s, pack_sockaddr_un($path)) or die "connect: $!";

sub put {
    my ($fh, $data) = @_;
    while (length $data) {
        my $n = syswrite($fh, $data);
        die "write: $!" unless defined $n;
        substr($data, 0, $n) = "";
    }
}

sub line {
    my $line = "";
    while (sysread($s, my $c, 1)) {
        $line .= $c;
        last if $c eq "\n";
    }
    return $line;
}

sub nonce {
    my $line = line();
    if ($line !~ /^nonce (\S+)\n\z/) {
        put(\*STDOUT, $line);
        exit 3;
    }
    return $1;
}

sub relay {
    my ($stdin) = @_;
    my $select = IO::Select->new($s);
    $select->add(\*STDIN) if $stdin;
    while (my @ready = $select->can_read) {
        for my $fh (@ready) {
            my $n = sysread($fh, my $data, 65536);
            if (fileno($fh) == fileno($s)) {
                return unless $n;
                put(\*STDOUT, $data);
            } elsif ($n) {
                put($s, $data);
            } else {
                $select->remove(\*STDIN);
            }
        }
    }
}

sub in_child {
    my ($body) = @_;
    my $pid = fork() // die "fork: $!";
    if ($pid == 0) {
        $body->();
        POSIX::_exit(0);
    }
    waitpid($pid, 0);
}

if ($mode eq "relay") {
    my $nonce = nonce();
    put($s, "hello $nonce\n");
    relay(1);
} elsif ($mode eq "early") {
    put($s, "keys\n");
    nonce();
    relay(0);
} elsif ($mode eq "wrong") {
    nonce();
    put($s, "hello " . ("A" x 43) . "=\n");
    relay(0);
} elsif ($mode eq "fork-echo") {
    my $nonce = nonce();
    in_child(sub { put($s, "hello $nonce\n"); relay(0); });
} elsif ($mode eq "fork-request") {
    my $nonce = nonce();
    put($s, "hello $nonce\n");
    put(\*STDOUT, line());
    put($s, "keys\n");
    put(\*STDOUT, line());
    in_child(sub { put($s, "create\n"); relay(0); });
} elsif ($mode eq "exec-echo") {
    my $nonce = nonce();
    defined POSIX::dup2(fileno($s), 9) or die "dup2: $!";
    exec("/bin/sh", "-c", 'printf "hello %s\n" "$1" >&9; exec cat <&9', "sh", $nonce) or die "exec: $!";
} else {
    die "unknown mode $mode";
}
"""#
}
