#!/usr/bin/python3
"""
udf-mail-passwd - let a councillor change their own @udf-party.co.za webmail
password from the Roundcube UI, without ever handing the mailbox credential
store to PHP.

Why a daemon on a unix socket instead of the stock Roundcube password drivers:

  * The webmail pool runs with
    `disable_functions = exec,passthru,shell_exec,system,proc_open,popen,show_source`.
    Every shipped driver that could touch a Dovecot passwd file needs one of
    those (`dovecot_passwdfile` writes the file from PHP, `chpasswd` uses
    popen(), the `dovecot` hash algorithm uses proc_open()).
  * The alternative - making `/etc/dovecot/users` readable *and writable* by
    www-data and opening `/etc/dovecot` to `open_basedir` - would mean one PHP
    or Roundcube compromise rewrites the hash of any of the 25 councillor
    mailboxes. That file is deliberately root:root 0600.

So the web tier keeps exactly one capability, over a socket, and it is the
capability we actually want to delegate: "set the password of mailbox U to P,
provided you can already authenticate as U". Everything else - the file
format, the hashing, who may ask - stays in this root-only program.

Protocol (one request per connection, three lines in, one line back):

    ->  <user>\n<current password>\n<new password>\n
    <-  OK\n                               (changed)
    <-  ERR <CODE>\n                       (nothing written)

Codes: MALFORMED, DENY, UNKNOWN_USER, UNSUPPORTED_SCHEME, BAD_CURRENT, WEAK,
IO, HASH. Passwords never appear in argv, in the environment or in the log -
only the username and the outcome are recorded.

The socket is group-readable so only `www-data` (and root) may connect, and the
peer credentials are checked again on every accepted connection.
"""

import crypt
import grp
import hmac
import json
import os
import socket
import stat
import struct
import subprocess
import sys
import time
import traceback

USERS_FILE = os.environ.get("UDF_MAIL_USERS", "/etc/dovecot/users")
SOCKET_PATH = os.environ.get("UDF_MAIL_SOCKET", "/run/udf-mail-passwd/mail.sock")
SOCKET_GROUP = os.environ.get("UDF_MAIL_SOCKET_GROUP", "www-data")
ALLOWED_UIDS = {0, 33}  # root (ops/CLI) and www-data (the webmail pool)

MAIL_DOMAIN = os.environ.get("UDF_MAIL_DOMAIN", "udf-party.co.za")
MIN_LENGTH = 10
MAX_LENGTH = 128
DOVEADM_PW = ["/usr/bin/doveadm", "pw", "-s", "SHA512-CRYPT"]
SCHEME = "{SHA512-CRYPT}"
MAX_LINE = 512


def log(event, user, detail=""):
    """Structured, secret-free audit line on stdout (journald)."""
    print(json.dumps({"ts": int(time.time()), "event": event, "user": user, "detail": detail}), flush=True)


def read_line(conn, limit=MAX_LINE):
    """Read one \\n-terminated line without ever buffering an unbounded request."""
    buf = bytearray()
    while True:
        ch = conn.recv(1)
        if not ch:
            break
        if ch == b"\n":
            return buf.decode("utf-8", "surrogateescape")
        buf += ch
        if len(buf) > limit:
            return None
    return None  # EOF before a newline: malformed


def stored_hash_of(line):
    """field 2 of a passwd-file line, or None if it is not a scheme we understand."""
    fields = line.rstrip("\n").split(":")
    if len(fields) < 2:
        return None, None
    value = fields[1]
    if not value.startswith(SCHEME):
        return None, None
    return value[len(SCHEME):], fields


def verify(current, raw_hash):
    """Constant-time check of a plaintext against a $6$salt$digest SHA512-crypt."""
    parts = raw_hash.split("$")
    # ['', '6', '<salt>', '<digest>']
    if len(parts) != 4 or parts[1] != "6":
        return False
    stored_salt = "$%s$%s$" % (parts[1], parts[2])
    candidate = crypt.crypt(current, stored_salt)
    return hmac.compare_digest(candidate.encode("utf-8", "surrogateescape"), raw_hash.encode())


def hash_password(newpass):
    """
    Hash with dovecot's own tool so the scheme, rounds and format are exactly
    what the auth daemon expects, then re-verify the result before it is
    written: a hash that does not round-trip must never reach the file.
    """
    payload = ("%s\n%s\n" % (newpass, newpass)).encode("utf-8", "surrogateescape")
    try:
        proc = subprocess.run(
            DOVEADM_PW, input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.decode("utf-8", "surrogateescape").strip()
    if not out.startswith(SCHEME):
        return None
    raw = out[len(SCHEME):]
    if not verify(newpass, raw):
        return None
    return out


def rewrite(target_user, new_field):
    """
    Replace field 2 for exactly one line, atomically, keeping the file 0600 and
    root:root. Any other line is copied through byte-for-byte.
    """
    try:
        with open(USERS_FILE, "r", encoding="utf-8", errors="surrogateescape") as fh:
            lines = fh.readlines()
    except OSError:
        return "IO"

    hit = 0
    out = []
    for line in lines:
        fields = line.rstrip("\n").split(":")
        if fields and fields[0] == target_user:
            hit += 1
            fields[1] = new_field
            line = ":".join(fields) + "\n"
        out.append(line)

    if hit != 1:
        # 0 means it vanished under us; >1 means the file is inconsistent and we
        # must not guess which row the user meant.
        return "UNKNOWN_USER" if hit == 0 else "IO"

    tmp = "%s.tmp.%d" % (USERS_FILE, os.getpid())
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape") as fh:
            fh.writelines(out)
            fh.flush()
            os.fsync(fh.fileno())
        os.chown(tmp, 0, 0)
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, USERS_FILE)
        dirfd = os.open(os.path.dirname(USERS_FILE) or "/", os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return "IO"
    return None


def peer_credentials(conn):
    """
    (pid, uid, gid) of whoever connected.

    Read straight from SO_PEERCRED rather than through socket.getpeercred():
    that helper is not exposed on every build, and a missing attribute here
    must not turn into "any local user may connect".
    """
    try:
        raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    except OSError:
        return None
    if len(raw) < 12:
        return None
    pid, uid, gid = struct.unpack("iii", raw[:12])
    return pid, uid, gid


def handle(conn, uid, gid):
    if uid not in ALLOWED_UIDS:
        log("deny", "-", "uid=%d" % uid)
        conn.sendall(b"ERR DENY\n")
        return

    user = read_line(conn)
    current = read_line(conn)
    newpass = read_line(conn)
    if user is None or current is None or newpass is None:
        conn.sendall(b"ERR MALFORMED\n")
        return
    if not user or "\r" in user or not user.endswith("@" + MAIL_DOMAIN):
        conn.sendall(b"ERR MALFORMED\n")
        log("malformed", user[:80], "domain")
        return
    if len(newpass) < MIN_LENGTH or len(newpass) > MAX_LENGTH:
        conn.sendall(b"ERR WEAK\n")
        log("reject", user, "length")
        return

    try:
        with open(USERS_FILE, "r", encoding="utf-8", errors="surrogateescape") as fh:
            matching = [ln for ln in fh if ln.split(":", 1)[0] == user]
    except OSError:
        conn.sendall(b"ERR IO\n")
        return
    if len(matching) != 1:
        conn.sendall(b"ERR UNKNOWN_USER\n")
        log("unknown-user", user, "count=%d" % len(matching))
        return

    raw_hash, _ = stored_hash_of(matching[0])
    if raw_hash is None:
        # Refuse rather than guess: rewriting a row whose scheme we cannot
        # verify would let an unauthenticated value through.
        conn.sendall(b"ERR UNSUPPORTED_SCHEME\n")
        log("reject", user, "scheme")
        return

    if not verify(current, raw_hash):
        conn.sendall(b"ERR BAD_CURRENT\n")
        log("bad-current", user)
        time.sleep(1)  # blunt the effect of a flood of guesses
        return

    new_field = hash_password(newpass)
    if new_field is None:
        conn.sendall(b"ERR HASH\n")
        log("hash-failed", user)
        return

    err = rewrite(user, new_field)
    if err:
        conn.sendall(("ERR %s\n" % err).encode())
        log("write-failed", user, err)
        return

    # auth_cache_size is 0 on this host, so Dovecot picks the new hash up on the
    # next login with no reload. Postfix does not read this file at all.
    conn.sendall(b"OK\n")
    log("changed", user)


def serve():
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    # bind() creates the inode with mode 0777 & ~umask, so the umask is set
    # first: a world-connectable socket, even for a few microseconds, would let
    # any local user queue a password change.
    os.umask(0o177)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCKET_PATH)
    gid = int(grp.getgrnam(SOCKET_GROUP).gr_gid)
    os.chown(SOCKET_PATH, 0, gid)
    os.chmod(SOCKET_PATH, 0o0660)
    srv.listen(8)
    log("start", "-", SOCKET_PATH)
    while True:
        try:
            conn, _ = srv.accept()
        except OSError as exc:
            log("accept-error", "-", str(exc))
            continue
        try:
            peer = peer_credentials(conn)
            if peer is None:
                log("deny", "-", "no SO_PEERCRED")
                conn.sendall(b"ERR DENY\n")
            else:
                handle(conn, peer[1], peer[2])
        except OSError as exc:
            # The client hung up before the reply (a browser tab closed, a PHP
            # fatal). Nothing was half-written: the file is only replaced after
            # the whole decision path has run, so this is noise, not damage.
            log("aborted", "-", type(exc).__name__)
        except Exception:  # never let one request kill the service
            # A traceback names the failing line but not its values, so this
            # cannot leak a password into the journal.
            log("error", "-", traceback.format_exc().strip().replace("\n", " | ")[-300:])
            try:
                conn.sendall(b"ERR IO\n")
            except OSError:
                pass
        finally:
            conn.close()


if __name__ == "__main__":
    if os.geteuid() != 0:
        print("must run as root", file=sys.stderr)
        sys.exit(1)
    serve()
