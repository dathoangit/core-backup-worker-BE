import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const PREFIX = 'enc:v1:';

/**
 * AES-256-GCM helpers for secret settings.
 * SETTINGS_SECRET_KEY may be 64-char hex, base64 32-byte, or any passphrase (scrypt-derived).
 */
export function resolveSettingsKey(raw: string | undefined): Uint8Array {
  if (!raw?.trim()) {
    throw new Error(
      'SETTINGS_SECRET_KEY is required to store/read secret settings (e.g. HIS_PASSWORD)',
    );
  }

  const trimmed = raw.trim();

  if (/^[\dA-Fa-f]{64}$/.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed, 'hex'));
  }

  try {
    const b64 = Buffer.from(trimmed, 'base64');

    if (b64.length === 32) {
      return new Uint8Array(b64);
    }
  } catch {
    // fall through
  }

  return new Uint8Array(scryptSync(trimmed, 'his-raw-backup-settings', 32));
}

export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const key = resolveSettingsKey(keyMaterial);
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    new Uint8Array(cipher.update(plaintext, 'utf8')),
    new Uint8Array(cipher.final()),
  ]);
  const tag = new Uint8Array(cipher.getAuthTag());

  return `${PREFIX}${Buffer.from(iv).toString('base64url')}.${Buffer.from(
    tag,
  ).toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(ciphertext: string, keyMaterial: string): string {
  if (!ciphertext.startsWith(PREFIX)) {
    return ciphertext;
  }

  const key = resolveSettingsKey(keyMaterial);
  const body = ciphertext.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split('.');

  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted setting payload');
  }

  const iv = new Uint8Array(Buffer.from(ivB64, 'base64url'));
  const tag = new Uint8Array(Buffer.from(tagB64, 'base64url'));
  const data = new Uint8Array(Buffer.from(dataB64, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    new Uint8Array(decipher.update(data)),
    new Uint8Array(decipher.final()),
  ]).toString('utf8');
}

export function isEncryptedPayload(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(PREFIX));
}
