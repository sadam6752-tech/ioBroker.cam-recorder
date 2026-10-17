'use strict';

/**
 * Removes credentials from a text before it reaches a log line, a state or an answer.
 *
 * Every `scheme://user:password@` part is replaced, and every given secret (also in its
 * percent-encoded form) is replaced wherever it appears, e.g. in the stderr of ffmpeg.
 * Secrets shorter than three characters are only removed from URLs - replacing them
 * everywhere would garble the whole text.
 *
 * @param {unknown} text - Text to clean
 * @param {Array<string | undefined | null>} [secrets] - Passwords and user names to hide
 * @returns {string} The cleaned text
 */
function maskSecrets(text, secrets = []) {
    let out = String(text ?? '');
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1***:***@');
    /** @type {string[]} */
    const plain = [];
    for (const s of secrets) {
        if (typeof s === 'string' && s.length >= 3) {
            plain.push(s, encodeURIComponent(s));
        }
    }
    const list = plain.sort((a, b) => b.length - a.length);
    for (const secret of list) {
        out = out.split(secret).join('***');
    }
    return out;
}

module.exports = { maskSecrets };
