'use strict';

/**
 * Online or offline of cameras behind UniFi Protect. Their RTSP URL (`rtsp://<console>:7447/<alias>` or
 * `rtsps://<console>:7441/<alias>`) belongs to the console, not to the camera: the camera sends its video to the
 * console, which serves it on. The console accepts a TCP connection while the camera is off, so the adapter asks the
 * console instead: it logs in with a local user (the API of the Protect web app, as the adapter unifi-protect does)
 * and reads `isConnected` of the camera whose channel has the alias of the URL.
 */

const https = require('node:https');

/** Ports of the RTSP and RTSPS streams of a UniFi Protect console. */
const UNIFI_PORTS = { rtsp: 7447, rtsps: 7441 };

/** Wait after a refused login before the next try: the console blocks a user after too many wrong logins. */
const LOGIN_PAUSE_MS = 15 * 60_000;

/**
 * @typedef {object} HttpAnswer
 * @property {number} status - HTTP status
 * @property {Record<string, string | string[] | undefined>} headers - Headers, lower case
 * @property {string} body - Body
 */

/**
 * @typedef {(options: {host: string, port: number, path: string, method: string,
 *   headers: Record<string, string>, body?: string, timeoutMs: number}) => Promise<HttpAnswer>} HttpRequest
 */

/**
 * @param {string} url - Camera URL without login
 * @returns {{host: string, alias: string} | null} Console and alias of a UniFi Protect stream, else null
 */
function unifiStream(url) {
    const m = /^(rtsps?):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+):(\d+)\/([A-Za-z0-9]+)(?:[/?#]|$)/i.exec(
        String(url ?? '').trim(),
    );
    if (!m) {
        return null;
    }
    const scheme = /** @type {'rtsp' | 'rtsps'} */ (m[1].toLowerCase());
    if (Number(m[3]) !== UNIFI_PORTS[scheme]) {
        return null;
    }
    return { host: m[2].replace(/^\[|\]$/g, ''), alias: m[4] };
}

/**
 * @param {unknown} cameras - Answer of `/proxy/protect/api/cameras`
 * @returns {Map<string, boolean>} Online state by RTSP alias of every channel
 */
function aliasStates(cameras) {
    if (!Array.isArray(cameras)) {
        throw new Error('the console sent no camera list');
    }
    /** @type {Map<string, boolean>} */
    const states = new Map();
    for (const camera of cameras) {
        if (!camera || typeof camera !== 'object') {
            continue;
        }
        const online =
            typeof camera.isConnected === 'boolean' ? camera.isConnected : String(camera.state) === 'CONNECTED';
        for (const channel of Array.isArray(camera.channels) ? camera.channels : []) {
            if (channel && typeof channel.rtspAlias === 'string' && channel.rtspAlias) {
                states.set(channel.rtspAlias, online);
            }
        }
    }
    return states;
}

/**
 * @param {string | string[] | undefined} header - `set-cookie` of an answer
 * @returns {string} `TOKEN=…` (or the first cookie), empty when there is none
 */
function sessionCookie(header) {
    const cookies = (Array.isArray(header) ? header : header ? [header] : []).map(c => c.split(';')[0].trim());
    return cookies.find(c => c.startsWith('TOKEN=')) || cookies[0] || '';
}

/**
 * @param {string} cookie - `TOKEN=<jwt>`
 * @returns {string} The CSRF token inside the JWT, empty when there is none
 */
function csrfFromCookie(cookie) {
    try {
        const payload = cookie.slice(cookie.indexOf('=') + 1).split('.')[1];
        return String(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).csrfToken || '');
    } catch {
        return '';
    }
}

/** @type {HttpRequest} */
function httpsRequest({ host, port, path, method, headers, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            // the console has a certificate of its own, signed by nobody
            { host, port, path, method, headers, rejectUnauthorized: false, timeout: timeoutMs },
            res => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode || 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    }),
                );
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
        req.on('error', reject);
        req.end(body);
    });
}

/** One UniFi Protect console: login, kept session, camera list. */
class UnifiConsole {
    /**
     * @param {object} options - Options
     * @param {string} options.host - Console
     * @param {number} options.port - HTTPS port of the console
     * @param {string} options.username - Local user of the console
     * @param {string} options.password - Password
     * @param {number} options.timeoutMs - Time to wait for an answer
     * @param {HttpRequest} [options.request] - Replaceable in tests
     * @param {() => number} [options.now] - Replaceable in tests
     */
    constructor({ host, port, username, password, timeoutMs, request = httpsRequest, now = Date.now }) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.timeoutMs = timeoutMs;
        this.request = request;
        this.now = now;
        this.cookie = '';
        this.csrf = '';
        /** time before which no login is tried after a refused one */
        this.pauseUntil = 0;
        this.pauseReason = '';
    }

    /**
     * @returns {Promise<Map<string, boolean>>} Online state by RTSP alias
     */
    async cameraStates() {
        if (!this.cookie) {
            await this._login();
        }
        let answer = await this._get('/proxy/protect/api/cameras');
        if (answer.status === 401 || answer.status === 403) {
            // the session ran out
            this.cookie = '';
            await this._login();
            answer = await this._get('/proxy/protect/api/cameras');
        }
        if (answer.status !== 200) {
            throw new Error(`the camera list was answered with HTTP ${answer.status}`);
        }
        let list;
        try {
            list = JSON.parse(answer.body);
        } catch {
            throw new Error('the camera list is no JSON');
        }
        return aliasStates(list);
    }

    /** Logs in with the local user and keeps the session cookie and the CSRF token. */
    async _login() {
        if (this.now() < this.pauseUntil) {
            throw new Error(`${this.pauseReason}, next login at ${new Date(this.pauseUntil).toLocaleTimeString()}`);
        }
        const answer = await this.request({
            host: this.host,
            port: this.port,
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ username: this.username, password: this.password, rememberMe: true }),
            timeoutMs: this.timeoutMs,
        });
        if (answer.status === 401 || answer.status === 403 || answer.status === 429) {
            this.pauseUntil = this.now() + LOGIN_PAUSE_MS;
            this.pauseReason =
                answer.status === 429
                    ? 'the console blocks the login for now (too many tries)'
                    : 'the console refused user or password';
            throw new Error(this.pauseReason);
        }
        if (answer.status === 404) {
            throw new Error('no UniFi OS console at this address (HTTP 404 for the login)');
        }
        if (answer.status !== 200) {
            throw new Error(`the login was answered with HTTP ${answer.status}`);
        }
        const cookie = sessionCookie(answer.headers['set-cookie']);
        if (!cookie) {
            throw new Error('the console sent no session cookie');
        }
        this.cookie = cookie;
        this._takeCsrf(answer);
    }

    /**
     * @param {HttpAnswer} answer - Answer of the console
     */
    _takeCsrf(answer) {
        const header = answer.headers['x-updated-csrf-token'] || answer.headers['x-csrf-token'];
        this.csrf =
            String(Array.isArray(header) ? header[0] : header || '') || csrfFromCookie(this.cookie) || this.csrf;
    }

    /**
     * @param {string} path - Path
     * @returns {Promise<HttpAnswer>} Answer
     */
    async _get(path) {
        /** @type {Record<string, string>} */
        const headers = { Accept: 'application/json', Cookie: this.cookie };
        if (this.csrf) {
            headers['X-CSRF-Token'] = this.csrf;
        }
        const answer = await this.request({
            host: this.host,
            port: this.port,
            path,
            method: 'GET',
            headers,
            timeoutMs: this.timeoutMs,
        });
        const cookie = sessionCookie(answer.headers['set-cookie']);
        if (cookie) {
            this.cookie = cookie;
        }
        if (answer.status === 200) {
            this._takeCsrf(answer);
        }
        return answer;
    }
}

/**
 * @param {unknown} value - Value of a state that tells whether a camera is online
 * @returns {boolean | null} Online or offline, null for no value
 */
function onlineValue(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    return ['true', '1', 'on', 'online', 'connected', 'yes', 'ok', 'reachable', 'up'].includes(
        String(value).trim().toLowerCase(),
    );
}

module.exports = { UNIFI_PORTS, LOGIN_PAUSE_MS, unifiStream, aliasStates, onlineValue, UnifiConsole };
