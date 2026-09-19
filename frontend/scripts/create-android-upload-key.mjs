#!/usr/bin/env node
// Explicit first-release setup only. Never replace an existing signing identity.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.argv[2] !== '--create') {
  throw new Error('First Play release only: pass --create after approving a new upload key.');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const privateDir = join(root, 'secrets/android');
const keystore = join(privateDir, 'udf-upload.p12');
const properties = join(privateDir, 'keystore.properties');
const certificate = join(privateDir, 'udf-upload-certificate.pem');
for (const path of [keystore, properties, certificate, join(root, 'frontend/android/keystore.properties')]) {
  if (existsSync(path)) throw new Error(`Existing signing material found; refusing to overwrite: ${path}`);
}
if (!process.env.JAVA_HOME) throw new Error('Set JAVA_HOME to the Java 17 installation.');
process.umask(0o077);
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
chmodSync(privateDir, 0o700);
const password = randomBytes(32).toString('hex');
const keytool = join(process.env.JAVA_HOME, 'bin/keytool');
const env = { ...process.env, UDF_UPLOAD_PASSWORD: password };
// Persist credentials first, with exclusive creation, so interrupted key generation is recoverable.
writeFileSync(properties, [
  'storeFile=../../secrets/android/udf-upload.p12',
  `storePassword=${password}`,
  'keyAlias=udf-upload',
  `keyPassword=${password}`,
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
execFileSync(keytool, [
  '-genkeypair', '-noprompt', '-keystore', keystore, '-storetype', 'PKCS12',
  '-alias', 'udf-upload', '-keyalg', 'RSA', '-keysize', '3072',
  '-sigalg', 'SHA256withRSA', '-validity', '10000',
  '-dname', 'CN=UDF Party Upload, O=UDF Party, C=ZA',
  '-storepass:env', 'UDF_UPLOAD_PASSWORD', '-keypass:env', 'UDF_UPLOAD_PASSWORD',
], { env, stdio: 'pipe' });
chmodSync(keystore, 0o600);
execFileSync(keytool, [
  '-exportcert', '-rfc', '-keystore', keystore, '-alias', 'udf-upload',
  '-storepass:env', 'UDF_UPLOAD_PASSWORD', '-file', certificate,
], { env, stdio: 'pipe' });
console.log('Created the new upload key and public certificate. No credentials were printed.');
console.log('Securely back up secrets/android/ (key AND keystore.properties) outside this machine.');
