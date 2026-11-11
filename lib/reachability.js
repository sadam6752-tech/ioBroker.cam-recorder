'use strict';

const net = require('node:net');

/** Default ports of the schemes a camera URL can have. */
const DEFAULT_PORTS = { rtsp: 554, rtsps: 322, http: 80, https: 443 };

/** How often the cameras are checked. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * Host and port that a reachability check connects to. The check only opens a TCP connection,
 * so it sends no login and starts no ffmpeg.
 *
 * @param {string} url - Camera URL without login
 * @returns {{host: string, port: number} | null} Target, or null for a URL that is no network address
 */
function probeTarget(url) {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(String(url ?? '').trim());
    if (!match) {
        return null;
    }
    const scheme = match[1].toLowerCase();
    const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
    // [IPv6]:port, host:port or host
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
    const plain = /^([^:]+)(?::(\d+))?$/.exec(authority);
    const host = v6 ? v6[1] : plain ? plain[1] : '';
    const port = Number((v6 ? v6[2] : plain ? plain[2] : '') || DEFAULT_PORTS[scheme] || 0);
    if (!host || !(port > 0 && port < 65536)) {
        return null;
    }
    return { host, port };
}

/**
 * Opens a TCP connection to the camera and closes it at once.
 *
 * @param {{host: string, port: number}} target - Host and port
 * @param {number} timeoutMs - Time to wait for the connection
 * @param {typeof net.connect} [connect] - Replaceable in tests
 * @returns {Promise<boolean>} True when the camera accepted the connection
 */
function isReachable(target, timeoutMs, connect = net.connect) {
    return new Promise(resolve => {
        let done = false;
        const socket = connect({ host: target.host, port: target.port });
        const finish = (/** @type {boolean} */ ok) => {
            if (!done) {
                done = true;
                socket.destroy();
                resolve(ok);
            }
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

module.exports = { CHECK_INTERVAL_MS, probeTarget, isReachable };
