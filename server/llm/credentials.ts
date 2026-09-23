/**
 * Credential resolution for provider rows (security.md, "Where credentials
 * live"). A `credential_ref` is a NAME — an environment variable locally, a
 * Key Vault secret name in production — and the value is never written to
 * the database, never logged and never returned by the API.
 *
 * Resolution order:
 *  1. `process.env[ref]` when set (local dev, docker-compose, a dedicated
 *     install that injects secrets as env).
 *  2. Azure Key Vault when `AZURE_KEY_VAULT_URL` is set: `getSecret(name)`
 *     through `DefaultAzureCredential` (managed identity on Container Apps,
 *     the developer's `az login` locally). Key Vault names allow letters,
 *     digits and dashes only, so an env-style ref (`ANTHROPIC_API_KEY`) is
 *     looked up as `ANTHROPIC-API-KEY`. Results are cached for five minutes;
 *     rotation is writing a new secret version and waiting out the cache.
 *
 * The Azure SDKs are imported lazily so a build without a vault never loads
 * them.
 */

export const CREDENTIAL_CACHE_MS = 5 * 60_000;

const REF_RE = /^[A-Za-z0-9_.-]{1,127}$/;

/** A ref is an identifier, never free text — it is interpolated into a vault lookup. */
export function isValidCredentialRef(ref: string): boolean {
  return REF_RE.test(ref);
}

/** `ANTHROPIC_API_KEY` → `ANTHROPIC-API-KEY` (Key Vault secret-name rules). */
export function keyVaultSecretName(ref: string): string {
  return ref.replace(/[^A-Za-z0-9-]/g, '-');
}

interface SecretClientLike {
  getSecret(name: string): Promise<{ value?: string }>;
}

type SecretClientFactory = (vaultUrl: string) => Promise<SecretClientLike>;

const defaultFactory: SecretClientFactory = async (vaultUrl) => {
  const [{ SecretClient }, { DefaultAzureCredential }] = await Promise.all([import('@azure/keyvault-secrets'), import('@azure/identity')]);
  return new SecretClient(vaultUrl, new DefaultAzureCredential());
};

let factory: SecretClientFactory = defaultFactory;
let clientPromise: Promise<SecretClientLike> | null = null;
let clientVaultUrl: string | null = null;
const cache = new Map<string, { at: number; value: string | null }>();

/** Test seam: a fake Key Vault client; null restores the real SDK. Clears the cache. */
export function setSecretClientFactoryForTests(f: SecretClientFactory | null): void {
  factory = f ?? defaultFactory;
  clientPromise = null;
  clientVaultUrl = null;
  cache.clear();
}

/** Forget cached secrets (a rotation the admin wants picked up now). */
export function clearCredentialCache(): void {
  cache.clear();
}

function keyVaultUrl(): string | null {
  const v = process.env.AZURE_KEY_VAULT_URL?.trim();
  return v ? v : null;
}

function vaultClient(vaultUrl: string): Promise<SecretClientLike> {
  if (!clientPromise || clientVaultUrl !== vaultUrl) {
    clientVaultUrl = vaultUrl;
    clientPromise = factory(vaultUrl).catch((err: unknown) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/**
 * The secret a ref names, or null when nothing holds it. Never throws on a
 * vault error — a missing key surfaces as the provider's 401, which the
 * reliability layer categorizes as `auth`, not as a crash.
 */
export async function resolveCredential(ref: string | null | undefined): Promise<string | null> {
  const name = ref?.trim() ?? '';
  if (!name || !isValidCredentialRef(name)) return null;
  const fromEnv = process.env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

  const vaultUrl = keyVaultUrl();
  if (!vaultUrl) return null;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CREDENTIAL_CACHE_MS) return hit.value;
  try {
    const client = await vaultClient(vaultUrl);
    const secret = await client.getSecret(keyVaultSecretName(name));
    const value = typeof secret.value === 'string' && secret.value ? secret.value : null;
    cache.set(name, { at: Date.now(), value });
    return value;
  } catch (err) {
    // The name is safe to log; the value never is.
    console.warn(`[llm] Key Vault lookup for ${name} failed:`, (err as Error).message);
    cache.set(name, { at: Date.now(), value: null });
    return null;
  }
}

/** Where a ref would be read from, for the settings UI's status dot. Never the value. */
export async function credentialStatus(ref: string): Promise<'env' | 'key-vault' | 'missing'> {
  const name = ref.trim();
  if (!name || !isValidCredentialRef(name)) return 'missing';
  if (typeof process.env[name] === 'string' && process.env[name]?.trim()) return 'env';
  if (keyVaultUrl() && (await resolveCredential(name)) !== null) return 'key-vault';
  return 'missing';
}
