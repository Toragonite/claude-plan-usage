import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { parseAuthStatus, classifyAccount, getAuthStatus, type AuthStatus } from '../src/auth';

/**
 * The four payload shapes `claude auth status --json` was measured emitting.
 * They are inlined rather than kept as fixtures because their whole value is
 * being readable next to the assertions that disambiguate them.
 */
const PAYLOADS = {
  envApiKey: {
    loggedIn: true,
    authMethod: 'api_key',
    apiProvider: 'firstParty',
    apiKeySource: 'ANTHROPIC_API_KEY',
  },
  apiKeyHelper: {
    loggedIn: true,
    authMethod: 'api_key_helper',
    apiProvider: 'firstParty',
    apiKeySource: 'apiKeyHelper',
  },
  subscription: {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'user@example.com',
    orgId: 'org_123',
    orgName: 'Example',
    subscriptionType: 'max',
  },
  loggedOut: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
} as const;

/** An auth reading with no probe error, for the classification truth table. */
function makeAuth(over: Partial<AuthStatus> = {}): AuthStatus {
  return {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    apiKeySource: null,
    email: null,
    subscriptionType: null,
    raw: null,
    fetchedAt: 1_000_000,
    ...over,
  };
}

describe('parseAuthStatus — measured payloads', () => {
  it('parses an ANTHROPIC_API_KEY account', () => {
    expect(parseAuthStatus(PAYLOADS.envApiKey)).toEqual({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
      apiKeySource: 'ANTHROPIC_API_KEY',
      email: null,
      subscriptionType: null,
    });
  });

  it('parses an apiKeyHelper account', () => {
    expect(parseAuthStatus(PAYLOADS.apiKeyHelper)).toEqual({
      loggedIn: true,
      authMethod: 'api_key_helper',
      apiProvider: 'firstParty',
      apiKeySource: 'apiKeyHelper',
      email: null,
      subscriptionType: null,
    });
  });

  it('parses a healthy subscription login, ignoring org fields', () => {
    expect(parseAuthStatus(PAYLOADS.subscription)).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      apiKeySource: null,
      email: 'user@example.com',
      subscriptionType: 'max',
    });
  });

  it('parses an expired / never-logged-in dir with no email', () => {
    expect(parseAuthStatus(PAYLOADS.loggedOut)).toEqual({
      loggedIn: false,
      authMethod: 'none',
      apiProvider: 'firstParty',
      apiKeySource: null,
      email: null,
      subscriptionType: null,
    });
  });

  // The whole point of the module: these two are indistinguishable to the usage
  // probe (both yield available:false, no error) and must differ here.
  it('separates a key/token account from a logged-out one', () => {
    expect(parseAuthStatus(PAYLOADS.envApiKey).loggedIn).toBe(true);
    expect(parseAuthStatus(PAYLOADS.loggedOut).loggedIn).toBe(false);
  });
});

describe('parseAuthStatus — junk and hostile inputs never throw', () => {
  it('degrades primitives, null, and arrays to a logged-out reading', () => {
    for (const junk of [null, undefined, 42, 'x', true, [], [1, 2, 3], NaN]) {
      expect(parseAuthStatus(junk)).toEqual({
        loggedIn: false,
        authMethod: null,
        apiProvider: null,
        apiKeySource: null,
        email: null,
        subscriptionType: null,
      });
    }
  });

  it('treats a missing loggedIn as logged out', () => {
    expect(parseAuthStatus({ authMethod: 'claude.ai' }).loggedIn).toBe(false);
  });

  it('treats a truthy non-boolean loggedIn as logged out', () => {
    expect(parseAuthStatus({ loggedIn: 'true' }).loggedIn).toBe(false);
    expect(parseAuthStatus({ loggedIn: 1 }).loggedIn).toBe(false);
  });

  it('nulls non-string fields rather than passing them through', () => {
    const result = parseAuthStatus({
      loggedIn: true,
      authMethod: 7,
      apiProvider: {},
      apiKeySource: [],
      email: null,
      subscriptionType: false,
    });
    expect(result).toEqual({
      loggedIn: true,
      authMethod: null,
      apiProvider: null,
      apiKeySource: null,
      email: null,
      subscriptionType: null,
    });
  });
});

describe('classifyAccount', () => {
  it('reports subscription when usage is available, whatever auth says', () => {
    const usage = { available: true };
    expect(classifyAccount(usage, makeAuth({ loggedIn: true }))).toBe('subscription');
    expect(classifyAccount(usage, makeAuth({ loggedIn: false }))).toBe('subscription');
    expect(classifyAccount(usage, makeAuth({ error: 'timeout' }))).toBe('subscription');
    expect(classifyAccount(usage, null)).toBe('subscription');
    expect(classifyAccount(usage, undefined)).toBe('subscription');
  });

  it('reports token when no plan limits but auth says logged in', () => {
    expect(classifyAccount({ available: false }, makeAuth({ loggedIn: true }))).toBe('token');
  });

  it('reports logged_out when no plan limits and auth says logged out', () => {
    expect(classifyAccount({ available: false }, makeAuth({ loggedIn: false }))).toBe('logged_out');
  });

  it('reports unknown when the auth evidence is missing', () => {
    expect(classifyAccount({ available: false }, null)).toBe('unknown');
    expect(classifyAccount({ available: false }, undefined)).toBe('unknown');
  });

  // Bias check: an errored auth probe is not evidence, so it must not be read as
  // "token" — that is exactly the wrong guess this function exists to avoid.
  it('reports unknown when the auth probe errored, regardless of loggedIn', () => {
    expect(classifyAccount({ available: false }, makeAuth({ error: 'timeout' }))).toBe('unknown');
    expect(
      classifyAccount({ available: false }, makeAuth({ loggedIn: false, error: 'timeout' })),
    ).toBe('unknown');
  });

  it('reports unknown when both readings are missing', () => {
    expect(classifyAccount(null, null)).toBe('unknown');
    expect(classifyAccount(undefined, undefined)).toBe('unknown');
  });

  // A failed usage probe never sets available:true, so auth alone decides.
  it('lets auth decide when the usage probe itself failed', () => {
    const failed = { available: false, error: 'timeout' };
    expect(classifyAccount(failed, makeAuth({ loggedIn: true }))).toBe('token');
    expect(classifyAccount(failed, makeAuth({ loggedIn: false }))).toBe('logged_out');
    expect(classifyAccount(failed, null)).toBe('unknown');
  });
});

describe('getAuthStatus — programmer-error validation (synchronous TypeError)', () => {
  it('throws TypeError for a zero, negative, NaN, Infinity, or non-number timeoutMs', () => {
    expect(() => getAuthStatus({ timeoutMs: 0 })).toThrow(TypeError);
    expect(() => getAuthStatus({ timeoutMs: -1 })).toThrow(TypeError);
    expect(() => getAuthStatus({ timeoutMs: NaN })).toThrow(TypeError);
    expect(() => getAuthStatus({ timeoutMs: Infinity })).toThrow(TypeError);
    // @ts-expect-error deliberately wrong type to exercise the runtime guard
    expect(() => getAuthStatus({ timeoutMs: '20000' })).toThrow(TypeError);
  });

  it('accepts a valid timeoutMs and undefined without throwing (no real process spawned)', async () => {
    await expect(
      getAuthStatus({ timeoutMs: 50, claudePath: '/nonexistent/definitely-missing-bin' }),
    ).resolves.toBeDefined();
    await expect(
      getAuthStatus({ claudePath: '/nonexistent/definitely-missing-bin' }),
    ).resolves.toBeDefined();
  });
});

describe('getAuthStatus — environmental failure resolves, never rejects', () => {
  it('resolves with error and loggedIn:false for a missing binary', async () => {
    const result = await getAuthStatus({
      claudePath: '/nonexistent/definitely-missing-bin',
      timeoutMs: 2000,
      configDir: os.tmpdir(),
    });
    expect(result.loggedIn).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.authMethod).toBeNull();
    expect(result.email).toBeNull();
    expect(result.raw).toBeNull();
    expect(typeof result.fetchedAt).toBe('number');
  });

  // An errored reading must classify as unknown, never as a token account.
  it('classifies a failed probe as unknown', async () => {
    const result = await getAuthStatus({
      claudePath: '/nonexistent/definitely-missing-bin',
      timeoutMs: 2000,
    });
    expect(classifyAccount({ available: false }, result)).toBe('unknown');
  });
});
