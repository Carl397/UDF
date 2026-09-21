<?php

/**
 * UDF mailbox driver for the Roundcube password plugin.
 *
 * Roundcube loads this through plugins/password/password.php::_load_driver():
 * `$config['password_driver'] = 'udf_mailbox'` looks for the class
 * `rcube_udf_mailbox_password` in `drivers/udf_mailbox.php`, and calls
 * `save($current, $new, $username)` expecting PASSWORD_SUCCESS or one of the
 * PASSWORD_* error codes.
 *
 * It does not touch /etc/dovecot/users itself, and it does not shell out. The
 * webmail FPM pool has exec/system/proc_open/popen disabled, and giving PHP
 * read-write access to the mailbox credential store would turn any web
 * compromise into a takeover of every councillor mailbox. Instead it speaks a
 * three-line protocol to the root-owned udf-mail-passwd helper over a unix
 * socket that only www-data may connect to; the helper re-checks the current
 * password before it writes anything, so this file being compromised buys
 * nothing on its own.
 *
 * Installed by deploy/scripts/enable-webmail-password.sh into the vendor
 * password plugin's drivers/ directory (that is where Roundcube looks), from
 * deploy/webmail/password-drivers/ in the repo. Re-run the script after a
 * Roundcube upgrade.
 *
 * @license GNU GPLv3+
 */
class rcube_udf_mailbox_password
{
    /** Must match RuntimeDirectory/ExecStart in udf-mail-passwd.service. */
    const SOCKET = 'unix:///run/udf-mail-passwd/mail.sock';
    const CONNECT_TIMEOUT = 3;
    const READ_TIMEOUT = 15;

    /**
     * Helper error code => [plugin constant, message shown to the user].
     *
     * Built in a method rather than as a property default: PASSWORD_* are
     * runtime `define()`s from the password plugin, and a property initializer
     * would tie this file's load order to theirs.
     */
    private static function errors()
    {
        return [
            'BAD_CURRENT'        => [PASSWORD_ERROR, 'The current password is not correct.'],
            'WEAK'               => [PASSWORD_CONSTRAINT_VIOLATION, 'The new password is too short (at least 10 characters).'],
            'UNKNOWN_USER'       => [PASSWORD_ERROR, 'That mailbox does not exist.'],
            'UNSUPPORTED_SCHEME' => [PASSWORD_CRYPT_ERROR, 'This mailbox uses a password format that cannot be changed here.'],
            'HASH'               => [PASSWORD_CRYPT_ERROR, 'The new password could not be hashed.'],
            'DENY'               => [PASSWORD_ERROR, 'Password changes are not permitted from this interface.'],
            'MALFORMED'          => [PASSWORD_ERROR, 'The password change request was rejected.'],
            'IO'                 => [PASSWORD_ERROR, 'The mailbox store could not be updated.'],
        ];
    }

    public function save($currpass, $newpass, $username)
    {
        $malformed = self::errors()['MALFORMED'];

        // The helper's protocol is line-based: a newline in any field would
        // let one field impersonate the next. Reject rather than sanitise.
        foreach ([$username, $currpass, $newpass] as $part) {
            if ($part === '' || $part === null || strpos((string) $part, "\n") !== false
                || strpos((string) $part, "\r") !== false || strlen((string) $part) > 512) {
                return ['code' => $malformed[0], 'message' => $malformed[1]];
            }
        }

        $connect_error = [PASSWORD_CONNECT_ERROR, self::errors()['IO'][1]];

        $errno = 0;
        $errstr = '';
        $sock = @stream_socket_client(
            self::SOCKET, $errno, $errstr, self::CONNECT_TIMEOUT, STREAM_CLIENT_CONNECT
        );
        if (!$sock) {
            rcube::raise_error([
                'code' => 600, 'file' => __FILE__, 'line' => __LINE__,
                'message' => "udf_mailbox: cannot reach the password helper ($errno $errstr)",
            ], true, false);
            return ['code' => $connect_error[0], 'message' => $connect_error[1]];
        }

        $payload = $username . "\n" . $currpass . "\n" . $newpass . "\n";
        $written = @fwrite($sock, $payload);
        if ($written === false || $written < strlen($payload)) {
            fclose($sock);
            return ['code' => $connect_error[0], 'message' => $connect_error[1]];
        }
        // Half-close the write side so the helper sees the end of the request,
        // and keep the read side open for its single reply. PHP's
        // stream_socket_shutdown() takes one $how flag, not the two-boolean
        // form that stream_socket_pair/stream_set_blocking uses.
        @stream_socket_shutdown($sock, STREAM_SHUT_WR);
        stream_set_timeout($sock, self::READ_TIMEOUT);

        $reply = fgets($sock, 128);
        fclose($sock);

        if ($reply === false) {
            rcube::raise_error([
                'code' => 600, 'file' => __FILE__, 'line' => __LINE__,
                'message' => 'udf_mailbox: the password helper returned nothing',
            ], true, false);
            return ['code' => $connect_error[0], 'message' => $connect_error[1]];
        }

        $reply = trim($reply);
        if ($reply === 'OK') {
            return PASSWORD_SUCCESS;
        }

        $errors = self::errors();
        $code = strpos($reply, 'ERR ') === 0 ? substr($reply, 4) : '';
        if (!isset($errors[$code])) {
            rcube::raise_error([
                'code' => 600, 'file' => __FILE__, 'line' => __LINE__,
                'message' => "udf_mailbox: unexpected helper reply '{$reply}'",
            ], true, false);
            $code = 'IO';
        }

        // Only the code is surfaced; the helper never echoes a password back.
        return ['code' => $errors[$code][0], 'message' => $errors[$code][1]];
    }
}
