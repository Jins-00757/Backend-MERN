import axios from 'axios';
import crypto from 'crypto';
import User from '../models/User.js';
import { config } from '../config/env.js';
import { encryptToken } from '../services/encryptionService.js';

/**
 * Salesforce OAuth 2.0 (Authorization Code + PKCE) controller.
 *
 * The whole round trip is handled on the backend:
 *  1. GET /auth-url  (authenticated) - builds the Salesforce authorize URL,
 *     stashes { state, verifier, userId } in short-lived signed cookies.
 *  2. Salesforce redirects the browser (GET) straight back to
 *     SALESFORCE_REDIRECT_URI, which points at STEP 3 below - never at the
 *     frontend - so the authorization code is never exposed to client JS.
 *  3. GET /callback - validates state, exchanges the code for tokens,
 *     encrypts + stores them, then redirects the browser back to the SPA.
 *
 * This avoids trusting a client-supplied userId and avoids relying on the
 * session cookie during the callback (it's SameSite=Strict and Salesforce's
 * redirect is a genuine cross-site navigation, so it would not be sent).
 */

const OAUTH_COOKIE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

/**
 * BUG FIX: 'lax' never survives being *set* by a cross-site XHR/fetch
 * response in the first place - fine when frontend and backend share a
 * site, but this app is deployed as two separate Render services (a static
 * site + a web service on different subdomains), which is genuinely
 * cross-site. getSalesforceAuthUrl() below sets these cookies as the
 * response to the frontend's `api.get('/auth/salesforce/auth-url')` XHR
 * call - a cross-site subresource request, not a top-level navigation - so
 * browsers never stored them, and the later redirect back from Salesforce
 * always failed with "invalid or expired OAuth state" even though nothing
 * had actually expired. Exact same bug, and exact same fix, as the main
 * session cookie in tokenService.js.setTokenCookie(): 'None' requires
 * `secure: true` (browsers reject it otherwise), which is exactly what
 * production already sets above.
 */
const oauthCookieOptions = () => {
  const isProduction = config.nodeEnv === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'strict',
    maxAge: OAUTH_COOKIE_MAX_AGE,
    signed: true,
  };
};

const clearOAuthCookies = (res) => {
  // clearCookie must be called with the same attributes the cookie was set
  // with (path/secure/sameSite) or the browser won't recognize it as the
  // same cookie to remove - passing none of them (as before) silently
  // failed to clear these in production.
  const isProduction = config.nodeEnv === 'production';
  const clearOptions = { secure: isProduction, sameSite: isProduction ? 'none' : 'strict' };
  res.clearCookie('oauth_state', clearOptions);
  res.clearCookie('oauth_uid', clearOptions);
  res.clearCookie('oauth_verifier', clearOptions);
};

const base64url = (buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * GET /api/auth/salesforce/auth-url
 * Generate the Salesforce OAuth authorization URL (PKCE)
 */
export const getSalesforceAuthUrl = (req, res) => {
  try {
    if (!config.salesforceClientId || !config.salesforceClientSecret) {
      return res.status(503).json({
        success: false,
        error: 'Salesforce integration is not configured on this server',
      });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

    res.cookie('oauth_state', state, oauthCookieOptions());
    res.cookie('oauth_uid', String(req.user._id), oauthCookieOptions());
    res.cookie('oauth_verifier', codeVerifier, oauthCookieOptions());

    const authUrl = new URL(config.salesforceAuthUrl);
    authUrl.searchParams.set('client_id', config.salesforceClientId);
    authUrl.searchParams.set('redirect_uri', config.salesforceRedirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'full refresh_token offline_access');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'login');

    res.json({
      success: true,
      authUrl: authUrl.toString(),
    });
  } catch (error) {
    console.error('❌ Error generating auth URL:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to generate authorization URL',
    });
  }
};

/**
 * GET /api/auth/salesforce/callback
 * Salesforce redirects the browser here directly (top-level GET navigation).
 * Exchanges the authorization code for tokens, stores them, then redirects
 * back to the SPA - the code/tokens never reach client-side JavaScript.
 */
export const handleSalesforceCallback = async (req, res) => {
  const redirectHome = (query) => res.redirect(`${config.clientUrl}/${query ? `?${query}` : ''}`);

  try {
    const { code, state, error: sfError } = req.query;

    const savedState = req.signedCookies?.oauth_state;
    const userId = req.signedCookies?.oauth_uid;
    const codeVerifier = req.signedCookies?.oauth_verifier;
    clearOAuthCookies(res);

    if (sfError) {
      console.error('❌ Salesforce denied authorization:', sfError);
      return redirectHome('sfError=denied');
    }

    if (!state || !savedState || state !== savedState || !userId) {
      console.error('❌ Salesforce callback: invalid or expired OAuth state');
      return redirectHome('sfError=state');
    }

    if (!code) {
      return redirectHome('sfError=missing_code');
    }

    // Exchange authorization code for access token
    const tokenResponse = await axios.post(
      config.salesforceTokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.salesforceClientId,
        client_secret: config.salesforceClientSecret,
        redirect_uri: config.salesforceRedirectUri,
        code,
        code_verifier: codeVerifier || '',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const { access_token, refresh_token, instance_url, id, expires_in } = tokenResponse.data;

    // Salesforce's "id" field looks like https://.../id/<orgId>/<userId>
    const salesforceUserId = id ? id.split('/').pop() : undefined;
    const orgHost = new URL(instance_url).hostname;
    const orgName = orgHost.split('.')[0];

    await User.findByIdAndUpdate(userId, {
      salesforceUserId,
      salesforceInstanceUrl: instance_url,
      salesforceAccessToken: encryptToken(access_token),
      salesforceRefreshToken: refresh_token ? encryptToken(refresh_token) : undefined,
      salesforceTokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : undefined,
      salesforceConnectedAt: new Date(),
      salesforceOrgName: orgName,
      isSalesforceConnected: true,
    });

    console.log(`✅ Salesforce connected for user ${userId}`);
    return redirectHome('sf=connected');
  } catch (error) {
    console.error('❌ Salesforce callback error:', error.response?.data || error.message);
    return redirectHome('sfError=connect_failed');
  }
};

/**
 * GET /api/auth/salesforce/status
 * Check if the authenticated user is connected to Salesforce
 */
export const getSalesforceStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user?.salesforceUserId) {
      return res.json({
        success: true,
        connected: false,
      });
    }

    res.json({
      success: true,
      connected: true,
      orgName: user.salesforceOrgName,
      connectedAt: user.salesforceConnectedAt,
    });
  } catch (error) {
    console.error('❌ Error checking Salesforce status:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to check Salesforce status',
    });
  }
};

/**
 * POST /api/auth/salesforce/disconnect
 * Disconnect the authenticated user's Salesforce account
 */
export const disconnectSalesforce = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      isSalesforceConnected: false,
      $unset: {
        salesforceUserId: '',
        salesforceInstanceUrl: '',
        salesforceAccessToken: '',
        salesforceRefreshToken: '',
        salesforceTokenExpiresAt: '',
        salesforceConnectedAt: '',
        salesforceOrgName: '',
      },
    });

    res.json({
      success: true,
      message: 'Salesforce account disconnected',
    });
  } catch (error) {
    console.error('❌ Error disconnecting Salesforce:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect Salesforce',
    });
  }
};

export default {
  getSalesforceAuthUrl,
  handleSalesforceCallback,
  getSalesforceStatus,
  disconnectSalesforce,
};
