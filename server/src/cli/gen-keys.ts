import { randomBytes } from 'node:crypto';

// Prints fresh 32-byte keys for .env. Use different keys for every environment.
console.log(`TOKEN_HMAC_KEY=${randomBytes(32).toString('base64')}`);
console.log(`DATA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
