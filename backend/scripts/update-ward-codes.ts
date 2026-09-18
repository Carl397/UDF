import { Client } from 'pg';
import { blindIndex } from '../src/security/blindIndex.js';

const c = new Client({ connectionString: 'postgres://party:party_dev_only@localhost:5433/party' });
await c.connect();

await c.query("UPDATE users SET ward_code=$1 WHERE email_bidx=$2", ['NORTH-W09', blindIndex('email', 'councillor.ward9@udf.example')]);
await c.query("UPDATE users SET ward_code=$1 WHERE email_bidx=$2", ['NORTH-W09', blindIndex('email', 'member.ward9@udf.example')]);
await c.query("UPDATE users SET ward_code=$1 WHERE email_bidx=$2", ['NORTH-W09', blindIndex('email', 'local.coordinator@udf.example')]);

console.log('Updated ward_code for test users');
await c.end();
