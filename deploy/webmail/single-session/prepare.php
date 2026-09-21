<?php
// CLI-only installer helper. Never installed under the webroot.
if (PHP_SAPI !== 'cli' || $argc !== 5) {
    exit(1);
}
[$script, $configPath, $dbPath, $backupPath, $candidatePath] = $argv;
$config = [];
require $configPath;
if (($config['session_storage'] ?? '') !== 'db'
    || ($config['db_prefix'] ?? '') !== ''
    || ($config['session_path'] ?? '/') !== '/'
    || !empty($config['session_domain'])
    || ($config['db_dsnw'] ?? '') !== 'sqlite:///' . $dbPath . '?mode=0640') {
    throw new RuntimeException('Unsupported Roundcube database/cookie configuration');
}
if (!is_file($dbPath) || is_file($backupPath) || is_file($candidatePath)) {
    throw new RuntimeException('Missing database or backup/candidate collision');
}
$db = new SQLite3($dbPath, SQLITE3_OPEN_READWRITE);
$db->enableExceptions(true);
$db->busyTimeout(5000);
if (version_compare(SQLite3::version()['versionString'], '3.24.0', '<')) {
    throw new RuntimeException('SQLite UPSERT support required');
}
$columns = [];
$result = $db->query('PRAGMA table_info(session)');
while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
    $columns[] = $row['name'];
}
if ($columns !== ['sess_id', 'changed', 'ip', 'vars']) {
    throw new RuntimeException('Unexpected Roundcube session schema');
}
$backup = new SQLite3($backupPath, SQLITE3_OPEN_READWRITE | SQLITE3_OPEN_CREATE);
$backup->enableExceptions(true);
if (!$db->backup($backup) || $backup->querySingle('PRAGMA integrity_check') !== 'ok') {
    throw new RuntimeException('SQLite online backup failed');
}
$backup->close();
chmod($backupPath, 0600);
$db->exec(file_get_contents(__DIR__ . '/schema.sql'));
$columns = [];
$result = $db->query('PRAGMA table_info(udf_session_policy)');
while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
    $columns[$row['name']] = (int) $row['pk'];
}
if ($columns !== ['user_id' => 1, 'token_hash' => 0, 'expires_at' => 0]) {
    throw new RuntimeException('Unexpected session policy schema');
}
$db->close();
$text = file_get_contents($configPath);
if (str_contains($text, '?>')) {
    throw new RuntimeException('Config must not close its PHP block');
}
$text = preg_replace('/\n?# BEGIN UDF-SESSIONS.*?# END UDF-SESSIONS\R?/s', '', $text);
$text .= <<<'BLOCK'

# BEGIN UDF-SESSIONS (managed by configure-mail-sessions.sh)
// Idle retention in minutes; plugin enforces the absolute 30-day deadline.
// Roundcube creates browser-session cookies; the plugin persists BOTH cookies.
$config['session_lifetime'] = 43200;
$config['ip_check'] = false;
$config['session_path'] = '/';
$config['session_samesite'] = 'Lax';
$config['plugins'] = array_values(array_unique(array_merge($config['plugins'] ?? [], ['udf_single_session'])));
# END UDF-SESSIONS

BLOCK;
if (file_put_contents($candidatePath, $text, LOCK_EX) === false) {
    throw new RuntimeException('Cannot prepare config candidate');
}
chmod($candidatePath, 0600);
echo "SQLite backup verified; policy schema ready; config candidate prepared\n";
