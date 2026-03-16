import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { readFile, writeFile, chmod, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const NANIT_API_BASE = 'https://api.nanit.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MFA_CODE_RE = /^\d{4,8}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

class NanitUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/auth/login', this.handleLogin.bind(this));
    this.onRequest('/auth/mfa', this.handleMfa.bind(this));
    this.onRequest('/auth/status', this.handleStatus.bind(this));
    this.onRequest('/auth/disconnect', this.handleDisconnect.bind(this));

    this.ready();
  }

  async handleLogin(payload) {
    const { email, password } = payload ?? {};

    if (!isNonEmptyString(email) || !EMAIL_RE.test(email)) {
      return { success: false, error: 'A valid email address is required' };
    }
    if (!isNonEmptyString(password)) {
      return { success: false, error: 'Password is required' };
    }

    try {
      const response = await fetch(`${NANIT_API_BASE}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'nanit-api-version': '1',
        },
        body: JSON.stringify({ email, password }),
      });

      if (response.status === 401) {
        return { success: false, error: 'Invalid email or password' };
      }

      if (response.status === 482) {
        const data = await response.json();
        return {
          success: true,
          mfaRequired: true,
          mfaToken: data.mfa_token,
          phoneSuffix: data.phone_suffix || '',
        };
      }

      if (response.status === 201) {
        const data = await response.json();
        await this.saveTokens(data.access_token, data.refresh_token);
        return { success: true, mfaRequired: false, refreshToken: data.refresh_token };
      }

      return { success: false, error: `Unexpected response: ${response.status}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async handleMfa(payload) {
    const { email, password, mfaToken, mfaCode } = payload ?? {};

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return { success: false, error: 'Email and password are required' };
    }
    if (!isNonEmptyString(mfaToken)) {
      return { success: false, error: 'MFA token is missing' };
    }
    if (!isNonEmptyString(mfaCode) || !MFA_CODE_RE.test(mfaCode.trim())) {
      return { success: false, error: 'A valid numeric verification code is required' };
    }

    try {
      const response = await fetch(`${NANIT_API_BASE}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'nanit-api-version': '1',
        },
        body: JSON.stringify({
          email,
          password,
          mfa_token: mfaToken,
          mfa_code: mfaCode,
        }),
      });

      if (response.status !== 201) {
        const text = await response.text();
        return { success: false, error: `MFA failed (${response.status}): ${text}` };
      }

      const data = await response.json();
      await this.saveTokens(data.access_token, data.refresh_token);
      return { success: true, refreshToken: data.refresh_token };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async handleStatus() {
    try {
      const tokenPath = join(this.homebridgeStoragePath, 'nanit-tokens.json');
      const data = await readFile(tokenPath, 'utf-8');
      const tokens = JSON.parse(data);
      return {
        authenticated: !!tokens.refreshToken,
        hasAccessToken: !!tokens.accessToken,
      };
    } catch {
      return { authenticated: false, hasAccessToken: false };
    }
  }

  async handleDisconnect() {
    try {
      // Delete the token file
      const tokenPath = join(this.homebridgeStoragePath, 'nanit-tokens.json');
      try {
        await unlink(tokenPath);
      } catch {
        // File may not exist — that's fine
      }

      // Remove auth.refreshToken from the plugin config
      try {
        const configBlocks = await this.getPluginConfig();
        if (configBlocks && configBlocks.length > 0) {
          const config = configBlocks[0];
          if (config.auth) {
            delete config.auth.refreshToken;
            if (Object.keys(config.auth).length === 0) {
              delete config.auth;
            }
          }
          await this.updatePluginConfig([config]);
          await this.savePluginConfig();
        }
      } catch {
        // Config update is best-effort
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async saveTokens(accessToken, refreshToken) {
    const tokenPath = join(this.homebridgeStoragePath, 'nanit-tokens.json');
    await mkdir(this.homebridgeStoragePath, { recursive: true });
    await writeFile(tokenPath, JSON.stringify({
      accessToken,
      refreshToken,
      authTime: Date.now(),
    }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await chmod(tokenPath, 0o600);
  }
}

(() => new NanitUiServer())();
