import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ENCRYPTION_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function decodeEncryptionKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

@Injectable()
export class ApiKeyEncryptionService {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    this.key = decodeEncryptionKey(
      configService.getOrThrow<string>('API_KEY_ENCRYPTION_KEY'),
    );
    if (this.key.length !== 32)
      throw new Error('API_KEY_ENCRYPTION_KEY must decode to 32 bytes');
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([ENCRYPTION_VERSION]),
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  decrypt(payload: Uint8Array): string {
    const value = Buffer.from(payload);
    const minimumLength = 1 + IV_BYTES + AUTH_TAG_BYTES;
    if (value.length < minimumLength || value[0] !== ENCRYPTION_VERSION) {
      throw new Error(
        'Provider credential has an unsupported encryption format',
      );
    }
    const iv = value.subarray(1, 1 + IV_BYTES);
    const tag = value.subarray(1 + IV_BYTES, minimumLength);
    const ciphertext = value.subarray(minimumLength);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  get version(): number {
    return ENCRYPTION_VERSION;
  }
}
