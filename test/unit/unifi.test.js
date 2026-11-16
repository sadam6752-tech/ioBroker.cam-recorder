'use strict';

const assert = require('node:assert/strict');
const { LOGIN_PAUSE_MS, unifiStream, aliasStates, onlineValue, UnifiConsole } = require('../../lib/unifi');
const { normalizeCameras, normalizeSettings } = require('../../lib/config');

/**
 * @param {object} payload - JWT payload
 * @returns {string} A cookie with an unsigned JWT
 */
function tokenCookie(payload) {
    const part = (/** @type {object} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `TOKEN=${part({ alg: 'HS256' })}.${part(payload)}.sig; path=/; samesite=none; secure; httponly`;
}

const CAMERAS = [
    { name: 'Einfahrt', isConnected: true, channels: [{ rtspAlias: 'aaa111' }, { rtspAlias: 'aaa222' }] },
    { name: 'Garten', isConnected: false, channels: [{ rtspAlias: 'bbb111' }, { rtspAlias: '' }] },
    { name: 'Old', state: 'CONNECTED', channels: [{ rtspAlias: 'ccc111' }] },
];

/**
 * A fake console: answers like UniFi OS.
 *
 * @param {object} [options] - Options
 * @param {number} [options.loginStatus] - Status of the login
 * @param {number[]} [options.listStatus] - Status of the camera list, one per request
 * @returns {{request: import('../../lib/unifi').HttpRequest, calls: Array<{path: string, headers: Record<string,
 *   string>, body?: string}>}} The request function and what it got
 */
function fakeConsole({ loginStatus = 200, listStatus = [] } = {}) {
    /** @type {Array<{path: string, headers: Record<string, string>, body?: string}>} */
    const calls = [];
    const statuses = [...listStatus];
    return {
        calls,
        request: async ({ path, headers, body }) => {
            calls.push({ path, headers, body });
            if (path === '/api/auth/login') {
                return {
                    status: loginStatus,
                    headers: loginStatus === 200 ? { 'set-cookie': [tokenCookie({ csrfToken: 'csrf-1' })] } : {},
                    body: '{}',
                };
            }
            const status = statuses.shift() ?? 200;
            return { status, headers: {}, body: status === 200 ? JSON.stringify(CAMERAS) : '{}' };
        },
    };
}

describe('UniFi Protect', () => {
    it('recognizes the streams of a console by port, with their alias', () => {
        assert.deepEqual(unifiStream('rtsp://192.168.1.1:7447/3MPDFDf68hgJfgbEe'), {
            host: '192.168.1.1',
            alias: '3MPDFDf68hgJfgbEe',
        });
        assert.deepEqual(unifiStream('rtsps://udm.local:7441/abcDEF123?enableSrtp'), {
            host: 'udm.local',
            alias: 'abcDEF123',
        });
        assert.deepEqual(unifiStream('rtsp://[fd00::1]:7447/x1'), { host: 'fd00::1', alias: 'x1' });
        assert.equal(unifiStream('rtsp://192.168.1.1:554/3MPDFDf68hgJfgbEe'), null);
        assert.equal(unifiStream('rtsp://192.168.1.1:7441/abc'), null);
        assert.equal(unifiStream('rtsp://192.168.1.1/abc'), null);
        assert.equal(unifiStream('rtsp://192.168.1.1:7447/'), null);
    });

    it('maps every channel alias to the connection of its camera', () => {
        const states = aliasStates(CAMERAS);
        assert.deepEqual(Object.fromEntries(states), { aaa111: true, aaa222: true, bbb111: false, ccc111: true });
        assert.throws(() => aliasStates({ error: 'x' }), /no camera list/);
    });

    it('logs in once, sends cookie and CSRF token, and reads the cameras', async () => {
        const fake = fakeConsole();
        const nvr = new UnifiConsole({
            host: 'udm',
            port: 443,
            username: 'viewer',
            password: 'secret',
            timeoutMs: 1000,
            request: fake.request,
        });
        assert.equal((await nvr.cameraStates()).get('bbb111'), false);
        await nvr.cameraStates();
        assert.deepEqual(
            fake.calls.map(c => c.path),
            ['/api/auth/login', '/proxy/protect/api/cameras', '/proxy/protect/api/cameras'],
        );
        assert.deepEqual(JSON.parse(String(fake.calls[0].body)), {
            username: 'viewer',
            password: 'secret',
            rememberMe: true,
        });
        assert.match(fake.calls[1].headers.Cookie, /^TOKEN=/);
        assert.equal(fake.calls[1].headers['X-CSRF-Token'], 'csrf-1');
    });

    it('logs in again when the session ran out', async () => {
        const fake = fakeConsole({ listStatus: [200, 401, 200] });
        const nvr = new UnifiConsole({
            host: 'udm',
            port: 443,
            username: 'u',
            password: 'p',
            timeoutMs: 1000,
            request: fake.request,
        });
        await nvr.cameraStates();
        await nvr.cameraStates();
        assert.deepEqual(
            fake.calls.map(c => c.path),
            [
                '/api/auth/login',
                '/proxy/protect/api/cameras',
                '/proxy/protect/api/cameras',
                '/api/auth/login',
                '/proxy/protect/api/cameras',
            ],
        );
    });

    it('waits 15 minutes after a refused login', async () => {
        let now = 1_000_000;
        const fake = fakeConsole({ loginStatus: 401 });
        const nvr = new UnifiConsole({
            host: 'udm',
            port: 443,
            username: 'u',
            password: 'wrong',
            timeoutMs: 1000,
            request: fake.request,
            now: () => now,
        });
        await assert.rejects(nvr.cameraStates(), /refused user or password/);
        await assert.rejects(nvr.cameraStates(), /next login at/);
        assert.equal(fake.calls.length, 1);
        now += LOGIN_PAUSE_MS;
        await assert.rejects(nvr.cameraStates(), /refused/);
        assert.equal(fake.calls.length, 2);
    });

    it('reads the values of an online state', () => {
        for (const v of [true, 1, 'true', 'CONNECTED', 'online', 'On', 'ok']) {
            assert.equal(onlineValue(v), true, String(v));
        }
        for (const v of [false, 0, 'false', 'DISCONNECTED', 'CONNECTING', 'offline']) {
            assert.equal(onlineValue(v), false, String(v));
        }
        assert.equal(onlineValue(null), null);
        assert.equal(onlineValue(''), null);
    });

    it('takes the column online state and the login from the settings', () => {
        const { cameras } = normalizeCameras([
            {
                name: 'Einfahrt',
                url: 'rtsp://1.2.3.4:7447/abc',
                onlineState: ' unifi-protect.0.cameras.x.isConnected ',
            },
            { name: 'Door', url: 'rtsp://1.2.3.5/x' },
        ]);
        assert.equal(cameras[0].onlineState, 'unifi-protect.0.cameras.x.isConnected');
        assert.equal(cameras[1].onlineState, '');
        assert.deepEqual(normalizeSettings({}).unifi, { username: '', password: '', port: 443 });
        assert.deepEqual(normalizeSettings({ unifiUser: ' viewer ', unifiPassword: 'p', unifiPort: 7443 }).unifi, {
            username: 'viewer',
            password: 'p',
            port: 7443,
        });
    });
});
