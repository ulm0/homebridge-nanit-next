import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logging } from 'homebridge';
import { NANIT_API_BASE, NANIT_API_VERSION, AUTH_TOKEN_LIFETIME_MS } from '../settings.js';
import type { NanitTokens, NanitMfaChallenge } from './types.js';

export class AuthManager {
  private tokens: NanitTokens | null = null;
  private readonly tokenFilePath: string;

  constructor(
    private readonly log: Logging,
    private readonly storagePath: string,
  ) {
    this.tokenFilePath = join(storagePath, 'nanit-tokens.json');
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  get refreshToken(): string | null {
    return this.tokens?.refreshToken ?? null;
  }

  get isAuthenticated(): boolean {
    return this.tokens !== null && this.tokens.accessToken.length > 0;
  }

  get isTokenExpired(): boolean {
    if (!this.tokens) return true;
    return Date.now() - this.tokens.authTime > AUTH_TOKEN_LIFETIME_MS;
  }

  async initialize(configRefreshToken?: string): Promise<void> {
    try {
      const data = await readFile(this.tokenFilePath, 'utf-8');
      this.tokens = JSON.parse(data) as NanitTokens;
      this.log.debug('Loaded saved Nanit tokens');
    } catch {
      this.log.debug('No saved tokens found');
    }

    if (configRefreshToken && (!this.tokens || !this.tokens.refreshToken)) {
      this.tokens = {
        accessToken: '',
        refreshToken: configRefreshToken,
        authTime: 0,
      };
    }
  }

  async ensureValidToken(): Promise<string> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available. Please authenticate via the plugin settings UI.');
    }

    if (!this.isTokenExpired && this.tokens.accessToken) {
      return this.tokens.accessToken;
    }

    return this.refreshAccessToken();
  }

  async login(email: string, password: string): Promise<NanitMfaChallenge | NanitTokens> {
    const response = await fetch(`${NANIT_API_BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'nanit-api-version': NANIT_API_VERSION,
      },
      body: JSON.stringify({ email, password }),
    });

    if (response.status === 401) {
      throw new Error('Invalid email or password');
    }

    if (response.status === 482) {
      const data = await response.json() as NanitMfaChallenge;
      return data;
    }

    if (response.status !== 201) {
      throw new Error(`Login failed with status ${response.status}`);
    }

    const data = await response.json() as { access_token: string; refresh_token: string };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      authTime: Date.now(),
    };
    await this.saveTokens();
    return this.tokens;
  }

  async completeMfa(
    email: string,
    password: string,
    mfaToken: string,
    mfaCode: string,
  ): Promise<NanitTokens> {
    const response = await fetch(`${NANIT_API_BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'nanit-api-version': NANIT_API_VERSION,
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
      throw new Error(`MFA verification failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { access_token: string; refresh_token: string };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      authTime: Date.now(),
    };
    await this.saveTokens();
    return this.tokens;
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }

    this.log.debug('Refreshing Nanit access token...');

    const response = await fetch(`${NANIT_API_BASE}/tokens/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.tokens.refreshToken }),
    });

    if (response.status === 404) {
      this.tokens = null;
      await this.saveTokens();
      throw new Error('Refresh token expired. Please re-authenticate via plugin settings.');
    }

    if (!response.ok) {
      throw new Error(`Token refresh failed with status ${response.status}`);
    }

    const data = await response.json() as { access_token: string; refresh_token: string };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      authTime: Date.now(),
    };
    await this.saveTokens();
    this.log.debug('Nanit access token refreshed successfully');
    return this.tokens.accessToken;
  }

  private async saveTokens(): Promise<void> {
    try {
      await mkdir(this.storagePath, { recursive: true });
      await writeFile(this.tokenFilePath, JSON.stringify(this.tokens, null, 2), { encoding: 'utf-8', mode: 0o600 });
      await chmod(this.tokenFilePath, 0o600);
    } catch (err) {
      this.log.error('Failed to save Nanit tokens:', err);
    }
  }
}
