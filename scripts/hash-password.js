#!/usr/bin/env node
// Prints an AGENT_PASSWORD_HASH value ("salt:hash") for the given plaintext password,
// in the exact format server.js's verifyPassword() expects (scrypt, 64-byte derived key).
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`${salt}:${hash}`);
