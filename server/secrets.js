const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

function encryptionKey() {
  const encodedKey = process.env.GSQUAD_SECRETS_KEY;
  if (!encodedKey) throw new Error('GSQUAD_SECRETS_KEY is not configured.');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('GSQUAD_SECRETS_KEY must be a base64-encoded 32-byte key.');
  return key;
}

function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(':');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error('Stored secret has an unsupported format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encodedIv, 'base64'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { decryptSecret, encryptSecret };