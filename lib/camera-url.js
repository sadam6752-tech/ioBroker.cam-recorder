'use strict';

const SCHEME = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i;

/**
 * @param {string} value - Percent-encoded text
 * @returns {string} Decoded text, or the input when it is not valid percent encoding
 */
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Splits a login written into a camera URL (`rtsp://user:pass@host/path`) from the URL.
 * The last `@` before the path ends the login, so a password may contain an unencoded `@`.
 *
 * @param {string} rawUrl - URL as entered by the user
 * @returns {{url: string, username: string, password: string}} URL without login and the login parts
 */
function splitCredentials(rawUrl) {
    const text = String(rawUrl ?? '').trim();
    const match = SCHEME.exec(text);
    if (!match) {
        return { url: text, username: '', password: '' };
    }
    const rest = match[2];
    const at = rest.lastIndexOf('@');
    const firstSlash = rest.search(/[/?#]/);
    if (at < 0 || (firstSlash >= 0 && firstSlash < at && !rest.slice(0, at).includes(':'))) {
        return { url: text, username: '', password: '' };
    }
    const info = rest.slice(0, at);
    const colon = info.indexOf(':');
    const username = colon < 0 ? info : info.slice(0, colon);
    const password = colon < 0 ? '' : info.slice(colon + 1);
    return { url: match[1] + rest.slice(at + 1), username: safeDecode(username), password: safeDecode(password) };
}

/**
 * Builds the URL that ffmpeg opens: the login is percent-encoded, so special characters work.
 *
 * @param {string} url - URL without login
 * @param {string} [username] - User name
 * @param {string} [password] - Password
 * @returns {string} URL with login
 */
function buildInputUrl(url, username, password) {
    const match = SCHEME.exec(String(url ?? '').trim());
    if (!match || (!username && !password)) {
        return String(url ?? '').trim();
    }
    const login = encodeURIComponent(username || '') + (password ? `:${encodeURIComponent(password)}` : '');
    return `${match[1]}${login}@${match[2]}`;
}

/**
 * @param {string} url - Camera URL
 * @returns {boolean} True for rtsp:// and rtsps://
 */
function isRtsp(url) {
    return /^rtsps?:\/\//i.test(String(url ?? '').trim());
}

module.exports = { splitCredentials, buildInputUrl, isRtsp };
