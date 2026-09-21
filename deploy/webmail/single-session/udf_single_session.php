<?php

/**
 * One active Roundcube webmail session per account, with a fixed 30-day limit.
 * SQLite-only, installed by configure-mail-sessions.sh for Roundcube 1.6.19.
 *
 * An atomic single-row UPSERT selects the latest successful login. Every
 * authenticated request checks that row before dispatch; storage failure,
 * revocation, missing rows and expiry fail closed. Requests already authorized
 * may finish, but cannot resurrect a revoked session by writing their state.
 * Old sessions without a policy row need one fresh login at first activation.
 *
 * Roundcube's session table has no user_id; we never parse its serialized vars.
 * Only a hash of the regenerated PHP session ID is kept in our policy table.
 * Logout conditionally removes the current row, never another client's row.
 * Both session cookies persist until the same absolute expiry; Roundcube's
 * rotating auth-cookie value and CSRF checks remain in use. No saved password
 * or bypass login is added to the APK. This controls webmail, not native IMAP
 * clients or hardware enrollment; possessing both cookies can replay a session.
 *
 * @license GNU GPLv3+
 */
class udf_single_session extends rcube_plugin
{
    public $task = '.*';

    /** @var rcmail */
    private $rcmail;

    /** Sessions are held for 30 days (must match configure-mail-sessions.sh). */
    const LEDGER_TTL = 2592000;

    function init()
    {
        $this->rcmail = rcmail::get_instance();
        $this->add_hook('login_after', [$this, 'enforce_single_device']);
        $this->add_hook('startup', [$this, 'validate_session']);
        $this->add_hook('session_destroy', [$this, 'forget_session']);
        header_register_callback([$this, 'persist_cookies']);
    }

    /** Called after IMAP authentication and session ID regeneration. */
    function enforce_single_device($pop)
    {
        try {
            $uid = (int) $this->rcmail->user->ID;
            if (!$uid || !session_id()) {
                throw new RuntimeException('No authenticated session');
            }
            $expires = time() + self::LEDGER_TTL;
            // One atomic SQLite UPSERT, one row per numeric Roundcube user.
            // Concurrent logins have exactly one winner, even if a revoked
            // request later rewrites its own Roundcube session row.
            $this->query(
                'INSERT INTO udf_session_policy (user_id, token_hash, expires_at) VALUES (?, ?, ?) '
                . 'ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at',
                $uid, hash('sha256', session_id()), $expires
            );
            $_SESSION['udf_session_expires'] = $expires;
        } catch (Throwable $e) {
            rcube::write_log('errors', 'udf_single_session: policy unavailable; login denied');
            $this->rcmail->kill_session();
            return ['_task' => 'login', '_err' => 'session'];
        }
        return $pop;
    }

    function validate_session($args)
    {
        if (empty($_SESSION['user_id'])) {
            return $args;
        }
        try {
            $result = $this->query(
                'SELECT token_hash, expires_at FROM udf_session_policy WHERE user_id = ?',
                (int) $_SESSION['user_id']
            );
            $row = $this->rcmail->get_db_instance()->fetch_array($result);
            if (!$row || (int) $row['expires_at'] <= time()
                || !hash_equals($row['token_hash'], hash('sha256', session_id()))
                || !$this->rcmail->session->check_auth()) {
                throw new RuntimeException('Revoked or expired session');
            }
            $_SESSION['udf_session_expires'] = (int) $row['expires_at'];
            return $args;
        } catch (Throwable $e) {
            $this->rcmail->kill_session();
            $args['task'] = 'login';
            $args['action'] = '';
            return $args;
        }
    }

    private function query($sql, ...$params)
    {
        $db = $this->rcmail->get_db_instance();
        $result = $db->query($sql, ...$params);
        // Roundcube returns errors instead of necessarily throwing exceptions.
        if (!$result || $db->is_error()) {
            throw new RuntimeException('Session policy database error');
        }
        return $result;
    }

    function persist_cookies()
    {
        $expires = (int) ($_SESSION['udf_session_expires'] ?? 0);
        $name = $this->rcmail->config->get('session_auth_name') ?: 'roundcube_sessauth';
        if (empty($_SESSION['user_id']) || $expires <= time() || empty($_COOKIE[$name])) {
            return;
        }
        // Runs immediately before ANY response headers, including redirects
        // and AJAX: Roundcube may refresh sessauth during check_auth(). Neither
        // cookie nor the ledger expiry slides beyond the original login + 30d.
        $options = ['expires' => $expires, 'path' => '/', 'secure' => true,
            'httponly' => true, 'samesite' => 'Lax'];
        setcookie(session_name(), session_id(), $options);
        setcookie($name, $_COOKIE[$name], $options);
    }

    /** Runs before Roundcube clears identity, including on session failure. */
    function forget_session($pop)
    {
        try {
            if (!empty($_SESSION['user_id']) && session_id()) {
                // A revoked client's logout must never revoke the new client.
                $this->query('DELETE FROM udf_session_policy WHERE user_id = ? AND token_hash = ?',
                    (int) $_SESSION['user_id'], hash('sha256', session_id()));
            }
        } catch (Throwable $e) {
            rcube::write_log('errors', 'udf_single_session: logout ledger cleanup unavailable');
        }
        unset($_SESSION['udf_session_expires']);
        return $pop;
    }
}
