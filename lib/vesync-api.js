'use strict';

const https = require('https');
const crypto = require('crypto');

const API_HOSTS = {
  US: 'smartapi.vesync.com',
  EU: 'smartapi.vesync.eu',
};

const DEFAULTS = {
  appVersion: '5.6.60',
  phoneBrand: 'node-red-contrib-vesync',
  phoneOS: 'Android',
  clientType: 'vesyncApp',
  clientVersion: 'VeSync 5.6.60',
  appId: 'eldodkfj',
  acceptLanguage: 'en',
  terminalId: '2b970374f583f5195a89018a996166660',
};

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function traceId() {
  return String(Date.now());
}

/**
 * Make an HTTPS POST request to VeSync API.
 * @param {string} host - API hostname
 * @param {string} path - API endpoint path
 * @param {object} body - JSON body
 * @returns {Promise<object>} Parsed JSON response
 */
function apiCall(host, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': 'okhttp/3.12.1',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${responseData.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('API request timed out'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * VeSync API client.
 * Handles two-step OAuth authentication, token management,
 * device discovery, and device control via bypassV2 API.
 */
class VeSyncAPI {
  /**
   * @param {string} email - VeSync account email
   * @param {string} password - VeSync account password (plain text)
   * @param {string} region - Region code: 'US' or 'EU'
   * @param {string} [timeZone='Europe/Prague'] - IANA timezone
   */
  constructor(email, password, region = 'EU', timeZone = 'America/New_York') {
    this.email = email;
    this.passwordHash = md5(password);
    this.region = region.toUpperCase();
    this.timeZone = timeZone;
    this.host = API_HOSTS[this.region] || API_HOSTS.US;

    this.token = null;
    this.accountId = null;
    this.tokenExpiry = null;
  }

  /**
   * Check if the current token is valid and not expired.
   * @returns {boolean}
   */
  isAuthenticated() {
    if (!this.token || !this.accountId) return false;
    if (this.tokenExpiry && Date.now() > this.tokenExpiry - 86400000) return false;
    return true;
  }

  /**
   * Two-step OAuth login.
   * Step 1: authByPWDOrOTM → get authorizeCode + accountID
   * Step 2: loginByAuthorizeCode4Vesync → get token
   *
   * Handles cross-region redirect automatically.
   * @returns {Promise<{token: string, accountId: string}>}
   */
  async login() {
    // Step 1: Get authorization code
    const step1Body = {
      email: this.email,
      password: this.passwordHash,
      method: 'authByPWDOrOTM',
      acceptLanguage: DEFAULTS.acceptLanguage,
      accountID: '',
      authProtocolType: 'generic',
      clientInfo: DEFAULTS.phoneBrand,
      clientType: DEFAULTS.clientType,
      clientVersion: DEFAULTS.clientVersion,
      debugMode: false,
      osInfo: DEFAULTS.phoneOS,
      terminalId: DEFAULTS.terminalId,
      timeZone: this.timeZone,
      token: '',
      userCountryCode: this.region === 'EU' ? 'CZ' : 'US',
      appID: DEFAULTS.appId,
      sourceAppID: DEFAULTS.appId,
      traceId: traceId(),
    };

    // Always start with .com for step 1
    let step1Resp = await apiCall(
      API_HOSTS.US,
      '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
      step1Body
    );

    if (step1Resp.code !== 0) {
      throw new Error(`VeSync auth step 1 failed: ${step1Resp.msg} (code: ${step1Resp.code})`);
    }

    const authorizeCode = step1Resp.result.authorizeCode;
    this.accountId = step1Resp.result.accountID;

    // Step 2: Exchange authorization code for token
    const step2Body = {
      method: 'loginByAuthorizeCode4Vesync',
      authorizeCode: authorizeCode,
      acceptLanguage: DEFAULTS.acceptLanguage,
      accountID: '',
      clientInfo: DEFAULTS.phoneBrand,
      clientType: DEFAULTS.clientType,
      clientVersion: DEFAULTS.clientVersion,
      debugMode: false,
      emailSubscriptions: false,
      osInfo: DEFAULTS.phoneOS,
      terminalId: DEFAULTS.terminalId,
      timeZone: this.timeZone,
      token: '',
      userCountryCode: this.region === 'EU' ? 'CZ' : 'US',
      traceId: traceId(),
    };

    // Try region-specific host first
    let step2Resp = await apiCall(
      this.host,
      '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
      step2Body
    );

    // Handle cross-region redirect
    if (step2Resp.code === -11260022 && step2Resp.result && step2Resp.result.bizToken) {
      const redirectRegion = step2Resp.result.currentRegion
        || (this.region === 'EU' ? 'US' : 'EU');
      const bizToken = step2Resp.result.bizToken;
      const countryCode = step2Resp.result.countryCode || 'US';
      const redirectHost = API_HOSTS[redirectRegion] || API_HOSTS.US;

      step2Body.bizToken = bizToken;
      step2Body.regionChange = 'lastRegion';
      step2Body.userCountryCode = countryCode;

      const retryResp = await apiCall(
        redirectHost,
        '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
        step2Body
      );

      if (retryResp.code !== 0) {
        throw new Error(`VeSync auth step 2 cross-region retry failed: ${retryResp.msg} (code: ${retryResp.code})`);
      }

      // Update host for future requests
      step2Resp = retryResp;
      this.host = redirectHost;
      this.region = redirectRegion;
    }

    if (step2Resp.code !== 0) {
      throw new Error(`VeSync auth step 2 failed: ${step2Resp.msg} (code: ${step2Resp.code})`);
    }

    this.token = step2Resp.result.token;
    this.accountId = step2Resp.result.accountID;

    // Parse JWT expiry from token
    try {
      const payload = JSON.parse(
        Buffer.from(this.token.split('.')[1], 'base64').toString()
      );
      this.tokenExpiry = payload.exp;
      // If exp is in milliseconds
      if (this.tokenExpiry > 1e12) this.tokenExpiry = this.tokenExpiry;
      else this.tokenExpiry = this.tokenExpiry * 1000;
    } catch (_) {
      // Token valid for 30 days by default
      this.tokenExpiry = Date.now() + 30 * 86400000;
    }

    return { token: this.token, accountId: this.accountId };
  }

  /**
   * Ensure authenticated, login if needed.
   * @returns {Promise<void>}
   */
  async ensureAuth() {
    if (!this.isAuthenticated()) {
      await this.login();
    }
  }

  /**
   * Get list of all devices on the account.
   * @returns {Promise<Array>} Array of device objects
   */
  async getDevices() {
    await this.ensureAuth();

    const body = {
      token: this.token,
      accountID: this.accountId,
      timeZone: this.timeZone,
      method: 'devices',
      pageNo: 1,
      pageSize: 100,
      appVersion: DEFAULTS.appVersion,
      phoneBrand: DEFAULTS.phoneBrand,
      phoneOS: DEFAULTS.phoneOS,
      acceptLanguage: DEFAULTS.acceptLanguage,
      traceId: traceId(),
    };

    const resp = await apiCall(this.host, '/cloud/v1/deviceManaged/devices', body);

    if (resp.code !== 0) {
      throw new Error(`VeSync get devices failed: ${resp.msg} (code: ${resp.code})`);
    }

    return (resp.result && resp.result.list) || [];
  }

  /**
   * Send a bypassV2 command to a device.
   * @param {string} cid - Device CID
   * @param {string} configModule - Device config module string
   * @param {string} method - Payload method (e.g. 'getPurifierStatus')
   * @param {object} [data={}] - Payload data
   * @returns {Promise<object>} Result object from API
   */
  async bypassV2(cid, configModule, method, data = {}) {
    await this.ensureAuth();

    const body = {
      acceptLanguage: DEFAULTS.acceptLanguage,
      accountID: this.accountId,
      appVersion: DEFAULTS.appVersion,
      cid: cid,
      configModule: configModule,
      debugMode: false,
      deviceRegion: this.region,
      method: 'bypassV2',
      phoneBrand: DEFAULTS.phoneBrand,
      phoneOS: DEFAULTS.phoneOS,
      timeZone: this.timeZone,
      token: this.token,
      traceId: traceId(),
      payload: {
        data: data,
        method: method,
        source: 'APP',
      },
    };

    const resp = await apiCall(this.host, '/cloud/v2/deviceManaged/bypassV2', body);

    if (resp.code !== 0) {
      throw new Error(`VeSync bypassV2 failed: ${resp.msg} (code: ${resp.code})`);
    }

    return (resp.result && resp.result.result) || resp.result || {};
  }

  // ---- Air Purifier convenience methods ----

  /**
   * Get purifier status.
   * @param {string} cid
   * @param {string} configModule
   * @returns {Promise<object>} Status object with enabled, mode, level, air_quality, etc.
   */
  async getPurifierStatus(cid, configModule) {
    return this.bypassV2(cid, configModule, 'getPurifierStatus');
  }

  /**
   * Turn purifier on or off.
   * @param {string} cid
   * @param {string} configModule
   * @param {boolean} on - true = on, false = off
   */
  async setPurifierPower(cid, configModule, on) {
    return this.bypassV2(cid, configModule, 'setSwitch', {
      powerSwitch: on ? 1 : 0,
      switchIdx: 0,
    });
  }

  /**
   * Set purifier fan speed level.
   * @param {string} cid
   * @param {string} configModule
   * @param {number} level - Fan speed (1-4, depends on model)
   */
  async setPurifierLevel(cid, configModule, level) {
    return this.bypassV2(cid, configModule, 'setLevel', {
      levelIdx: 0,
      manualSpeedLevel: level,
      levelType: 'wind',
    });
  }

  /**
   * Set purifier mode.
   * @param {string} cid
   * @param {string} configModule
   * @param {string} mode - 'manual', 'auto', 'sleep'
   */
  async setPurifierMode(cid, configModule, mode) {
    return this.bypassV2(cid, configModule, 'setPurifierMode', {
      workMode: mode,
    });
  }

  /**
   * Set display on/off.
   * @param {string} cid
   * @param {string} configModule
   * @param {boolean} on
   */
  async setDisplay(cid, configModule, on) {
    return this.bypassV2(cid, configModule, 'setDisplay', {
      screenSwitch: on ? 1 : 0,
    });
  }

  /**
   * Set child lock.
   * @param {string} cid
   * @param {string} configModule
   * @param {boolean} on
   */
  async setChildLock(cid, configModule, on) {
    return this.bypassV2(cid, configModule, 'setChildLock', {
      childLockSwitch: on ? 1 : 0,
    });
  }
}

module.exports = { VeSyncAPI, API_HOSTS, DEFAULTS };
