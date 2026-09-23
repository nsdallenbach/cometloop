import { afterEach, describe, expect, it } from 'vitest';
import { credentialStatus, isValidCredentialRef, keyVaultSecretName, resolveCredential, setSecretClientFactoryForTests } from './credentials';

/**
 * A credential_ref is a NAME. Locally it is an environment variable; with
 * AZURE_KEY_VAULT_URL set it is a Key Vault secret, cached for five minutes.
 * The value is never returned to a caller that did not ask for the secret
 * itself (the adapters), and never logged.
 */

const ENV = 'CL_TEST_PROVIDER_KEY';

afterEach(() => {
  delete process.env[ENV];
  delete process.env.AZURE_KEY_VAULT_URL;
  setSecretClientFactoryForTests(null);
});

describe('resolveCredential', () => {
  it('reads the environment variable the ref names', async () => {
    process.env[ENV] = '  sk-from-env ';
    expect(await resolveCredential(ENV)).toBe('sk-from-env');
  });

  it('returns null for an empty, malformed or unset ref (never throws)', async () => {
    expect(await resolveCredential('')).toBeNull();
    expect(await resolveCredential(null)).toBeNull();
    expect(await resolveCredential('not a ref; drop table')).toBeNull();
    expect(await resolveCredential(ENV)).toBeNull();
  });

  it('falls back to Key Vault when configured, mapping the name and caching the value', async () => {
    process.env.AZURE_KEY_VAULT_URL = 'https://cl-test.vault.azure.net';
    const asked: string[] = [];
    setSecretClientFactoryForTests((vaultUrl) => {
      expect(vaultUrl).toBe('https://cl-test.vault.azure.net');
      return Promise.resolve({
        getSecret: (name: string) => {
          asked.push(name);
          return Promise.resolve({ value: 'sk-from-vault' });
        },
      });
    });
    expect(await resolveCredential(ENV)).toBe('sk-from-vault');
    expect(await resolveCredential(ENV)).toBe('sk-from-vault');
    expect(asked).toEqual(['CL-TEST-PROVIDER-KEY']);
    // The environment still wins when both hold the name.
    process.env[ENV] = 'sk-from-env';
    expect(await resolveCredential(ENV)).toBe('sk-from-env');
  });

  it('a vault error resolves to null and is not retried within the cache window', async () => {
    process.env.AZURE_KEY_VAULT_URL = 'https://cl-test.vault.azure.net';
    let calls = 0;
    setSecretClientFactoryForTests(() =>
      Promise.resolve({
        getSecret: () => {
          calls++;
          return Promise.reject(new Error('403 Forbidden'));
        },
      }),
    );
    expect(await resolveCredential(ENV)).toBeNull();
    expect(await resolveCredential(ENV)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('helpers', () => {
  it('validates refs and derives Key Vault names', () => {
    expect(isValidCredentialRef('ANTHROPIC_API_KEY')).toBe(true);
    expect(isValidCredentialRef('tenant-a.llm')).toBe(true);
    expect(isValidCredentialRef('has space')).toBe(false);
    expect(keyVaultSecretName('ANTHROPIC_API_KEY')).toBe('ANTHROPIC-API-KEY');
  });

  it('reports where a ref resolves from, never the value', async () => {
    expect(await credentialStatus(ENV)).toBe('missing');
    process.env[ENV] = 'x';
    expect(await credentialStatus(ENV)).toBe('env');
    delete process.env[ENV];
    process.env.AZURE_KEY_VAULT_URL = 'https://v';
    setSecretClientFactoryForTests(() => Promise.resolve({ getSecret: () => Promise.resolve({ value: 'y' }) }));
    expect(await credentialStatus(ENV)).toBe('key-vault');
  });
});
