'use strict';

const { splitCredentials } = require('./camera-url');

/**
 * Marks a password that the adapter has encrypted itself. `encryptedNative` only covers
 * top-level strings, the camera passwords live in a table, so the adapter encrypts them.
 */
const MARK = 'enc:';

/**
 * @param {unknown} value - Stored password
 * @returns {boolean} True if the value was encrypted by the adapter
 */
function isProtected(value) {
    return typeof value === 'string' && value.startsWith(MARK);
}

/**
 * @param {string} value - Stored password
 * @param {(value: string) => string} decrypt - `adapter.decrypt`
 * @returns {string} The plain password
 */
function revealPassword(value, decrypt) {
    if (!value) {
        return '';
    }
    return isProtected(value) ? decrypt(value.slice(MARK.length)) : value;
}

/**
 * Prepares the stored camera list: a login typed into the URL moves into the user and
 * password fields, and every plain password is encrypted.
 *
 * @param {Array<Record<string, any>>} cameras - `native.cameras` as stored
 * @param {(value: string) => string} encrypt - `adapter.encrypt`
 * @returns {{changed: boolean, cameras: Array<Record<string, any>>}} The list to store and whether it differs
 */
function protectCameras(cameras, encrypt) {
    let changed = false;
    const result = (Array.isArray(cameras) ? cameras : []).map(camera => {
        const next = { ...camera };
        const split = splitCredentials(next.url);
        if (split.username || split.password) {
            next.url = split.url;
            if (!next.username) {
                next.username = split.username;
            }
            if (!next.password) {
                next.password = split.password;
            }
            changed = true;
        }
        if (typeof next.password === 'string' && next.password && !isProtected(next.password)) {
            next.password = MARK + encrypt(next.password);
            changed = true;
        }
        return next;
    });
    return { changed, cameras: result };
}

module.exports = { MARK, isProtected, revealPassword, protectCameras };
