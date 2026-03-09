import type { Logging } from 'homebridge';
import { NANIT_API_BASE } from '../settings.js';
import type { AuthManager } from './auth.js';
import type { Baby, BabiesResponse } from './types.js';

export class NanitApiClient {
  private babies: Baby[] = [];

  constructor(
    private readonly log: Logging,
    private readonly auth: AuthManager,
  ) {}

  private async fetchAuthorized<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await this.auth.ensureValidToken();

    const isWebSocketRelated = path.startsWith('/focus/');
    const authHeader = isWebSocketRelated
      ? `Bearer ${token}`
      : token;

    const response = await fetch(`${NANIT_API_BASE}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401) {
      this.log.debug('Token expired, refreshing and retrying...');
      const newToken = await this.auth.refreshAccessToken();
      const retryAuthHeader = isWebSocketRelated
        ? `Bearer ${newToken}`
        : newToken;

      const retryResponse = await fetch(`${NANIT_API_BASE}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          'Authorization': retryAuthHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!retryResponse.ok) {
        throw new Error(`API request failed after retry: ${retryResponse.status}`);
      }

      return retryResponse.json() as Promise<T>;
    }

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${path}`);
    }

    return response.json() as Promise<T>;
  }

  async getBabies(): Promise<Baby[]> {
    const data = await this.fetchAuthorized<BabiesResponse>('/babies');
    this.babies = data.babies;
    return this.babies;
  }

  getCachedBabies(): Baby[] {
    return this.babies;
  }

  async getSnapshot(babyUid: string): Promise<Buffer | null> {
    const token = await this.auth.ensureValidToken();

    let response = await fetch(`${NANIT_API_BASE}/babies/${babyUid}/snapshot`, {
      headers: { 'Authorization': token },
    });

    if (response.status === 401) {
      const newToken = await this.auth.refreshAccessToken();
      response = await fetch(`${NANIT_API_BASE}/babies/${babyUid}/snapshot`, {
        headers: { 'Authorization': newToken },
      });
    }

    if (!response.ok) {
      this.log.debug(`Snapshot endpoint returned ${response.status} for baby ${babyUid}`);
      return null;
    }

    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async getUcToken(cameraUid: string): Promise<string> {
    const data = await this.fetchAuthorized<{ token: string }>(
      `/focus/cameras/${cameraUid}/uc_token`,
    );
    return data.token;
  }

  getCloudStreamUrl(babyUid: string): string {
    const token = this.auth.accessToken;
    if (!token) throw new Error('Not authenticated');
    return `rtmps://media-secured.nanit.com/nanit/${babyUid}.${token}`;
  }
}
