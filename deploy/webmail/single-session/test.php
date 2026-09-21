<?php
// Execute the actual plugin against in-memory SQLite, with Roundcube API stubs.
// Cookie headers and real IMAP authentication require the separate live test.
class rcube_plugin {
    public function add_hook($event, $callback) { rcmail::$hooks[$event] = $callback; }
}
class rcube {
    public static function write_log($target, $message) {}
}
class PolicyTestDb {
    public $pdo;
    public $failed = false;
    public function __construct() {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE users (user_id INTEGER PRIMARY KEY)');
        $this->pdo->exec(file_get_contents(__DIR__ . '/schema.sql'));
    }
    public function query($sql, ...$params) {
        if ($this->failed) return false;
        $q = $this->pdo->prepare($sql);
        $q->execute($params);
        return $q;
    }
    public function is_error() { return $this->failed; }
    public function fetch_array($q) { return $q->fetch(PDO::FETCH_ASSOC); }
}
class rcmail {
    public static $instance;
    public static $hooks = [];
    public $db;
    public $user;
    public $session;
    public $config;
    public function __construct() {
        $this->db = new PolicyTestDb;
        $this->user = (object) ['ID' => 0];
        $this->session = new class {
            public $valid = true;
            public function check_auth() { return $this->valid; }
        };
        $this->config = new class {
            public function get($key) { return null; }
        };
    }
    public static function get_instance() { return self::$instance; }
    public function get_db_instance() { return $this->db; }
    public function kill_session() {
        (self::$hooks['session_destroy'])([]);
        $_SESSION = [];
        $this->user->ID = 0;
    }
}
require __DIR__ . '/udf_single_session.php';
$rc = rcmail::$instance = new rcmail;
$plugin = new udf_single_session;
$plugin->init();
$results = [];
function check($value, $message) {
    global $results;
    if (!$value) throw new RuntimeException($message);
    $results[] = $message;
}
function client($user, $sid) {
    global $rc;
    session_id($sid);
    $_SESSION = ['user_id' => $user];
    $rc->user->ID = $user;
    $rc->session->valid = true;
}
function allowed($task = 'mail') {
    global $plugin;
    return $plugin->validate_session(['task' => $task, 'action' => 'index'])['task'] === $task;
}
client(1, 'device-a');
$plugin->enforce_single_device(['_task' => 'mail']);
check(allowed(), 'first client accepted');
$expiry = $_SESSION['udf_session_expires'];
check(abs($expiry - time() - 2592000) <= 1, 'absolute 30-day expiry');
check(allowed('settings') && $_SESSION['udf_session_expires'] === $expiry, 'all tasks checked; expiry does not slide');
client(2, 'other-account');
$plugin->enforce_single_device([]);
client(1, 'device-b');
$plugin->enforce_single_device([]);
check(allowed(), 'second client accepted');
check((int) $rc->db->pdo->query('SELECT COUNT(*) FROM udf_session_policy WHERE user_id=1')->fetchColumn() === 1, 'unique account row');
client(1, 'device-a');
check(!allowed(), 'old client rejected on next request');
client(1, 'device-b');
check(allowed(), 'old client cleanup cannot revoke winner');
client(2, 'other-account');
check(allowed(), 'other account unaffected');
client(1, 'device-a');
check(!allowed(), 'stale session rewrite cannot resurrect access');
client(1, 'device-b');
$rc->session->valid = false;
check(!allowed(), 'Roundcube authentication cookie still required');
client(1, 'device-c');
$plugin->enforce_single_device([]);
$rc->db->pdo->exec('UPDATE udf_session_policy SET expires_at=1 WHERE user_id=1');
check(!allowed(), 'expired session rejected server-side');
client(1, 'legacy-client');
check(!allowed(), 'unregistered pre-policy session rejected');
client(1, 'device-d');
$plugin->enforce_single_device([]);
$rc->kill_session();
check((int) $rc->db->pdo->query('SELECT COUNT(*) FROM udf_session_policy WHERE user_id=1')->fetchColumn() === 0, 'logout removes current authorization');
client(1, 'db-error');
$rc->db->failed = true;
check(($plugin->enforce_single_device([])['_task'] ?? '') === 'login' && $rc->user->ID === 0, 'login fails closed on non-throwing DB error');
client(2, 'other-account');
check(!allowed(), 'request fails closed on DB error');
$rc->db->failed = false;
// Simulate two overlapping authenticated login completions, then check both.
client(1, 'overlap-a');
$plugin->enforce_single_device([]);
client(1, 'overlap-b');
$plugin->enforce_single_device([]);
client(1, 'overlap-a');
check(!allowed(), 'overlapping login loser denied');
client(1, 'overlap-b');
check(allowed(), 'overlapping login last writer accepted');
$_SESSION = [];

// Rehearse the real installer helper using a disposable, non-sensitive fixture.
$fixture = dirname(__DIR__, 3) . '/.tmp-verify/mail-prepare-' . bin2hex(random_bytes(6));
if (!mkdir($fixture, 0700, true)) throw new RuntimeException('Cannot create fixture');
$dbPath = $fixture . '/roundcube.db';
$source = new SQLite3($dbPath);
$source->exec('CREATE TABLE users (user_id INTEGER PRIMARY KEY)');
$source->exec('CREATE TABLE session (sess_id varchar(128) PRIMARY KEY, changed datetime, ip varchar(40), vars TEXT)');
$source->exec("INSERT INTO session VALUES ('fixture', '2026-01-01', '127.0.0.1', 'fixture-only')");
$source->close();
$configPath = $fixture . '/config.php';
$originalConfig = "<?php\n\$config = " . var_export([
    'session_storage' => 'db',
    'db_dsnw' => 'sqlite:///' . $dbPath . '?mode=0640',
    'plugins' => ['archive', 'zipdownload', 'udf_branding', 'password'],
    'session_lifetime' => 30,
], true) . ";\n";
file_put_contents($configPath, $originalConfig);
function prepareFixture($config, $db, $backup, $candidate) {
    $pipes = [];
    $process = proc_open([PHP_BINARY, __DIR__ . '/prepare.php', $config, $db, $backup, $candidate],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException('Cannot run installer test');
    fclose($pipes[0]);
    stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return proc_close($process);
}
$candidate = $fixture . '/candidate.php';
$backupPath = $fixture . '/backup.db';
check(prepareFixture($configPath, $dbPath, $backupPath, $candidate) === 0, 'installer accepts exact Roundcube schema');
check(file_get_contents($configPath) === $originalConfig, 'installer does not change active config');
$backup = new SQLite3($backupPath, SQLITE3_OPEN_READONLY);
check($backup->querySingle('PRAGMA integrity_check') === 'ok'
    && $backup->querySingle('SELECT vars FROM session') === 'fixture-only', 'online backup preserves session data');
check((int) $backup->querySingle("SELECT count(*) FROM sqlite_master WHERE name='udf_session_policy'") === 0,
    'backup precedes policy schema mutation');
$backup->close();
check((fileperms($backupPath) & 0777) === 0600 && (fileperms($candidate) & 0777) === 0600,
    'backup and candidate restricted to owner');
$config = [];
require $candidate;
check($config['session_lifetime'] === 43200 && $config['session_samesite'] === 'Lax'
    && $config['plugins'] === ['archive', 'zipdownload', 'udf_branding', 'password', 'udf_single_session'],
    'candidate preserves plugins and applies policy configuration');
$second = $fixture . '/candidate-second.php';
check(prepareFixture($candidate, $dbPath, $fixture . '/backup-second.db', $second) === 0
    && file_get_contents($candidate) === file_get_contents($second), 'installer config is byte-idempotent');
check(prepareFixture($configPath, $dbPath, $backupPath, $candidate) !== 0,
    'installer refuses to overwrite backup or candidate');
$unsupported = $fixture . '/unsupported.php';
file_put_contents($unsupported, $originalConfig . "\$config['session_domain'] = '.example.invalid';\n");
check(prepareFixture($unsupported, $dbPath, $fixture . '/rejected.db', $fixture . '/rejected.php') !== 0
    && !file_exists($fixture . '/rejected.php'), 'unsupported cookie configuration cannot activate');
foreach ($results as $result) echo "PASS: $result\n";
echo count($results) . " checks passed; live cookie/IMAP test still required\n";
