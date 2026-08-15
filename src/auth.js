import { ConfidentialClientApplication, LogLevel, CryptoProvider } from '@azure/msal-node';

// Work IQ Gateway resource. A single delegated scope covers both REST and A2A.
export const WORKIQ_SCOPE = 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask';

export const REDIRECT_URI =
  process.env.REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/callback`;

const cryptoProvider = new CryptoProvider();

function assertConfigured() {
  const { ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET } = process.env;
  if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET) {
    throw new Error(
      'Missing ENTRA_TENANT_ID, ENTRA_CLIENT_ID or ENTRA_CLIENT_SECRET. Copy .env.example to .env and fill them in.'
    );
  }
}

export function isConfigured() {
  return Boolean(
    process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET
  );
}

/**
 * Build a confidential-client app whose token cache is bound to this session.
 * Creating it per request keeps each user's tokens isolated (multi-user / host ready).
 */
function clientForSession(session) {
  assertConfigured();
  const cachePlugin = {
    beforeCacheAccess: async (ctx) => {
      if (session.msalCache) ctx.tokenCache.deserialize(session.msalCache);
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) session.msalCache = ctx.tokenCache.serialize();
    },
  };

  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.ENTRA_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}`,
      clientSecret: process.env.ENTRA_CLIENT_SECRET,
    },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) console.error('[MSAL]', message);
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  });
}

/**
 * Step 1 of sign-in: return the Entra authorize URL to redirect the browser to.
 * Uses PKCE in addition to the client secret (defense in depth).
 */
export async function buildAuthCodeUrl(session) {
  const client = clientForSession(session);
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = cryptoProvider.createNewGuid();
  session.pkceVerifier = verifier;
  session.authState = state;

  return client.getAuthCodeUrl({
    scopes: [WORKIQ_SCOPE],
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
  });
}

/**
 * Step 2: exchange the authorization code for tokens. Stores the account in the session.
 */
export async function handleCallback(session, code, state) {
  if (!state || state !== session.authState) {
    throw new Error('State mismatch — possible CSRF. Please retry sign-in.');
  }
  const client = clientForSession(session);
  const result = await client.acquireTokenByCode({
    code,
    scopes: [WORKIQ_SCOPE],
    redirectUri: REDIRECT_URI,
    codeVerifier: session.pkceVerifier,
  });
  session.homeAccountId = result.account?.homeAccountId || null;
  session.username = result.account?.username || null;
  delete session.pkceVerifier;
  delete session.authState;
  return result.account;
}

/**
 * Acquire a delegated Work IQ access token for the user signed into this session.
 * Throws an error tagged needsLogin if the session is not (or no longer) signed in.
 */
export async function getAccessToken(session) {
  if (!session?.homeAccountId) {
    const err = new Error('Not signed in.');
    err.needsLogin = true;
    throw err;
  }
  const client = clientForSession(session);
  const account = await client.getTokenCache().getAccountByHomeId(session.homeAccountId);
  if (!account) {
    const err = new Error('Session expired. Please sign in again.');
    err.needsLogin = true;
    throw err;
  }
  try {
    const res = await client.acquireTokenSilent({ account, scopes: [WORKIQ_SCOPE] });
    return res.accessToken;
  } catch {
    const err = new Error('Token refresh failed. Please sign in again.');
    err.needsLogin = true;
    throw err;
  }
}

export function getSignedInUser(session) {
  return session?.username || null;
}

export function isSignedIn(session) {
  return Boolean(session?.homeAccountId);
}

export function signOut(session) {
  delete session.msalCache;
  delete session.homeAccountId;
  delete session.username;
}
