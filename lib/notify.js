'use strict';

const path = require('node:path');

/**
 * @typedef {import('./types').RecordResult} RecordResult
 * @typedef {import('./types').NotifyTarget} NotifyTarget
 */

/** Adapters with a known message format; others need a template. */
const KNOWN = [
    'telegram',
    'max',
    'email',
    'pushover',
    'discord',
    'matrix-org',
    'signal-cmb',
    'whatsapp-cmb',
    'gotify',
    'ntfy',
];

/**
 * @param {RecordResult | null} result - Finished file, null for a message without file
 * @param {string} caption - Caption
 * @param {string} [camera] - Camera name, for a message without file and caption
 * @returns {string} A text that names the file, for messengers that cannot send files
 */
function textOnly(result, caption, camera = '') {
    if (!result) {
        return caption || camera;
    }
    const kind = result.format === 'jpg' ? 'snapshot' : `${result.format} clip ${Math.round(result.duration)} s`;
    return `${caption ? `${caption}: ` : ''}${kind} (${path.basename(result.file)})`;
}

/**
 * @param {string} file - Local path
 * @returns {string} The path as file URL
 */
function fileUrl(file) {
    return `file://${file.replace(/\\/g, '/').replace(/^(?!\/)/, '/')}`;
}

/**
 * @param {string} text - Template text after JSON parsing
 * @param {Record<string, string>} values - Placeholder values
 * @returns {string} The text with `{name}` replaced
 */
function fill(text, values) {
    return text.replace(/\{(\w+)\}/g, (all, name) => (name in values ? values[name] : all));
}

/**
 * Builds the `sendTo` command and message for one target. The format follows what the
 * messaging adapter accepts; adapters that cannot send files get a text that names the file.
 * Without a result (profile with the attachment "Text only") every adapter gets the caption alone.
 *
 * @param {NotifyTarget} target - Target
 * @param {RecordResult | null} result - Finished file, null for a text without file
 * @param {string} caption - Caption
 * @param {string} [camera] - Camera name, needed when result is null
 * @returns {{command: string, message: unknown}} What to send
 */
function buildMessage(target, result, caption, camera = result ? result.camera : '') {
    const adapter = target.instance.split('.')[0];
    const recipient = target.recipient;
    const image = !!result && (result.format === 'jpg' || result.format === 'gif');
    const text = textOnly(result, caption, camera);
    if (target.template) {
        const values = {
            file: result ? result.file : '',
            fileName: result ? path.basename(result.file) : '',
            fileUrl: result ? fileUrl(result.file) : '',
            caption,
            camera,
            format: result ? result.format : '',
            duration: result ? String(result.duration) : '',
            recipient,
            text,
        };
        // placeholders are filled inside the parsed JSON, so quotes in values cannot break it
        const parsed = JSON.parse(target.template);
        return { command: 'send', message: mapStrings(parsed, s => fill(s, values)) };
    }
    switch (adapter) {
        case 'telegram':
            return {
                command: 'send',
                message: {
                    text: result ? result.file : text,
                    ...(result && caption ? { caption } : {}),
                    ...(recipient ? { user: recipient } : {}),
                },
            };
        case 'max': {
            // ioBroker.max: a positive number is a user, a negative one a group chat, empty = all known users
            /** @type {Record<string, unknown>} */
            const message = result
                ? { ...(caption ? { text: caption } : {}), [result.format === 'mp4' ? 'video' : 'image']: result.file }
                : { text };
            if (/^-\d+$/.test(recipient)) {
                message.chatId = Number(recipient);
            } else if (/^\d+$/.test(recipient)) {
                message.userId = Number(recipient);
            }
            return { command: 'send', message };
        }
        case 'email':
            return {
                command: 'send',
                message: {
                    ...(recipient ? { to: recipient } : {}),
                    subject:
                        caption || (result ? `${camera}: ${result.format === 'jpg' ? 'snapshot' : 'clip'}` : camera),
                    text,
                    ...(result ? { attachments: [{ filename: path.basename(result.file), path: result.file }] } : {}),
                },
            };
        case 'pushover':
            // Pushover attaches pictures only
            return {
                command: 'send',
                message: {
                    message: text,
                    ...(image && result ? { file: result.file } : {}),
                    ...(recipient ? { device: recipient } : {}),
                },
            };
        case 'discord': {
            /** @type {Record<string, unknown>} */
            const message = {
                content: {
                    content: caption || text,
                    ...(result ? { files: [{ attachment: result.file, name: path.basename(result.file) }] } : {}),
                },
            };
            const channel = /^(\d+)\/(\d+)$/.exec(recipient);
            if (channel) {
                message.serverId = channel[1];
                message.channelId = channel[2];
            } else if (/^\d+$/.test(recipient)) {
                message.userId = recipient;
            } else {
                message.userTag = recipient;
            }
            return { command: 'sendMessage', message };
        }
        case 'matrix-org':
            return image && result
                ? { command: 'send', message: { file: fileUrl(result.file) } }
                : { command: 'send', message: text };
        case 'signal-cmb':
        case 'whatsapp-cmb':
            return {
                command: 'send',
                message: { text, ...(recipient ? { phone: recipient } : {}) },
            };
        case 'gotify':
            return {
                command: 'send',
                message: { title: caption || camera, message: text },
            };
        case 'ntfy':
            return {
                command: 'send',
                message: {
                    title: caption || camera,
                    message: text,
                    ...(recipient ? { topic: recipient } : {}),
                },
            };
        default:
            throw new Error(`no message format known for "${adapter}", enter a template`);
    }
}

/**
 * @param {unknown} value - Parsed JSON
 * @param {(s: string) => string} map - String mapper
 * @returns {unknown} Copy with every string mapped
 */
function mapStrings(value, map) {
    if (typeof value === 'string') {
        return map(value);
    }
    if (Array.isArray(value)) {
        return value.map(v => mapStrings(v, map));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, map)]));
    }
    return value;
}

/** Name of the profile made from the Telegram instance of the settings before 0.5. */
const TELEGRAM_NAME = 'Telegram';

/**
 * Reads a list of names: `"Alex, Father"`, `"Alex;Father"` or an array. `—` and `-` mean none.
 *
 * @param {unknown} value - Names as entered
 * @returns {string[]} Trimmed names, no empty ones
 */
function parseNames(value) {
    const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/);
    return parts.map(p => String(p).trim()).filter(p => p && p !== '—' && p !== '-');
}

module.exports = { KNOWN, TELEGRAM_NAME, buildMessage, textOnly, parseNames };
