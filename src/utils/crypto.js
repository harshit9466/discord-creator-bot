const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_BYTES    = 12;
const ENC_MARKER = '__enc';

function loadKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY is missing or invalid (must be 64 hex chars / 32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

const KEY = loadKey();

function encryptString(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptString(packed) {
  const [ivB64, tagB64, ctB64] = packed.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

function isEncryptedWrapper(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value[ENC_MARKER] === true && typeof value.v === 'string';
}

// Encrypts any JSON-serializable value for storage in a JSON/JSONB column.
// null/undefined pass through untouched.
function encryptJsonField(value) {
  if (value === null || value === undefined) return value;
  return { [ENC_MARKER]: true, v: encryptString(JSON.stringify(value)) };
}

// Reverses encryptJsonField(). Anything not in the wrapper shape (legacy
// plaintext, or null) passes through unchanged.
function decryptJsonField(value) {
  if (value === null || value === undefined) return value;
  if (!isEncryptedWrapper(value)) return value;
  return JSON.parse(decryptString(value.v));
}

module.exports = { encryptJsonField, decryptJsonField, encryptString, decryptString };
