import axios from 'axios';
import { config } from '../config/env.js';
import { generateToken, setTokenCookie } from '../services/tokenService.js';
import { encryptToken } from '../services/encryptionservice.js';
import { AppError } from '../middleware/errorHandler.js';

// Generate Salesforce authorization URL
export const getSalesforceAuthUrl = (req, res, next) => {
  try {
    const state = Math.random().toString(36).substring(7); // Simple state token

    const params = new URLSearchParams({
      client_id: config.salesforce.clientId,
      redirect_uri: config.salesforce.redirectUri,
      response_type: 'code',
      scope: 'full refresh_token',
      state: state,
    });

    const authUrl = `${config.salesforce.authUrl}?${params.toString()}`;

    res.json({
      status: 'ok',
      authUrl,
      state,
    });
  } catch (err) {
    next(err);
  }
};

// Handle OAuth callback and exchange code for token
export const handleSalesforceCallback = async (req, res, next) => {
  try {
    const { code, state } = req.body;

    if (!code) {
      return next(new AppError('Authorization code is required', 400));
    }

    // Exchange code for access token
    const tokenResponse = await axios.post(
      config.salesforce.tokenUrl,
      {
        grant_type: 'authorization_code',
        client_id: config.salesforce.clientId,
        client_secret: config.salesforce.clientSecret,
        redirect_uri: config.salesforce.redirectUri,
        code,
      }
    );

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      instance_url: instanceUrl,
    } = tokenResponse.data;

    // Get user info from Salesforce
    const userInfoResponse = await axios.get(`${instanceUrl}/services/oauth2/userinfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const {
      sub: salesforceId,
      email,
      name,
      org_name: orgName,
    } = userInfoResponse.data;

    // For now, create/update user with Salesforce data
    // In production, integrate with your User model
    const user = {
      _id: `salesforce_${salesforceId}`,
      email,
      name,
      role: 'rep',
      salesforce: {
        isConnected: true,
        salesforceId,
        accessToken: encryptToken(accessToken),
        refreshToken: encryptToken(refreshToken),
        instanceUrl,
        orgName,
      },
    };

    // Generate JWT token for session
    const jwtToken = generateToken(user._id, user.email, user.role);
    setTokenCookie(res, jwtToken);

    res.json({
      status: 'ok',
      data: user,
    });
  } catch (err) {
    console.error('Salesforce OAuth error:', err);
    next(new AppError('Failed to authenticate with Salesforce', 401));
  }
};

// Disconnect Salesforce (optional)
export const disconnectSalesforce = async (req, res, next) => {
  try {
    // This would update the user's Salesforce data
    // req.user is set by protect middleware

    res.json({
      status: 'ok',
      message: 'Salesforce disconnected',
    });
  } catch (err) {
    next(err);
  }
};