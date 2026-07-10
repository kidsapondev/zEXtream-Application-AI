import { ApiKeyEncryptionService } from './api-key-encryption.service';

describe('ApiKeyEncryptionService', () => {
  const configService = {
    getOrThrow: jest.fn(() => Buffer.alloc(32, 7).toString('base64')),
  };

  it('encrypts API keys with a randomized authenticated payload', () => {
    const service = new ApiKeyEncryptionService(configService as never);

    const first = service.encrypt('secret-key');
    const second = service.encrypt('secret-key');

    expect(first.equals(second)).toBe(false);
    expect(first.toString('utf8')).not.toContain('secret-key');
    expect(service.decrypt(first)).toBe('secret-key');
  });

  it('rejects tampered ciphertext', () => {
    const service = new ApiKeyEncryptionService(configService as never);
    const payload = service.encrypt('secret-key');
    payload[payload.length - 1] ^= 1;

    expect(() => service.decrypt(payload)).toThrow();
  });
});
