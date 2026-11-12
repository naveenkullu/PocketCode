import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_VALUE_VERSION = "v1";

function resolveEncryptionKey(key: string | undefined): Buffer {
  if (!key || !/^[\da-fA-F]{64}$/.test(key)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.");
  }
  return Buffer.from(key, "hex");
}

export function encryptToken(
  plaintext: string,
  encryptionKey = process.env.TOKEN_ENCRYPTION_KEY,
): string {
  const key = resolveEncryptionKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTED_VALUE_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(
  encryptedValue: string,
  encryptionKey = process.env.TOKEN_ENCRYPTION_KEY,
): string {
  const key = resolveEncryptionKey(encryptionKey);
  const [version, encodedIv, encodedAuthTag, encodedCiphertext, ...extra] =
    encryptedValue.split(".");

  if (
    version !== ENCRYPTED_VALUE_VERSION ||
    !encodedIv ||
    !encodedAuthTag ||
    encodedCiphertext === undefined ||
    extra.length > 0
  ) {
    throw new Error("Unable to decrypt token.");
  }

  const iv = Buffer.from(encodedIv, "base64url");
  const authTag = Buffer.from(encodedAuthTag, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Unable to decrypt token.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt token.");
  }
}
