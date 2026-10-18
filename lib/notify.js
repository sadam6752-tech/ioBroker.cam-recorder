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
 * @param {RecordResult} result - Finished file
 * @param {string} caption - Caption
 * @returns {string} A text that names the file, for messengers that cannot send files
 */
function textOnly(result, caption) {
    const kind = result.format === 'jpg' ? 'snapshot' : `${result.format} clip ${Math.round(result.duration)} s`;
    return `${caption ? `${caption}: ` : ''}${kind} (${path.basename(result.file)})`;
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
 *
 * @param {NotifyTarget} target - Target
 * @param {RecordResult} result - Finished file
 * @param {string} caption - Caption
 * @returns {{command: string, message: unknown}} What to send
 */
function buildMessage(target, result, caption) {
    const adapter = target.instance.split('.')[0];
    const recipient = target.recipient;
    const image = result.format === 'jpg' || result.format === 'gif';
    if (target.template) {
        const values = {
            file: result.file,
            fileName: path.basename(result.file),
            fileUrl: `file://${result.file.replace(/\\/g, '/').replace(/^(?!\/)/, '/')}`,
            caption,
            camera: result.camera,
            format: result.format,
            duration: String(result.duration),
            recipient,
            text: textOnly(result, caption),
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
                    text: result.file,
                    ...(caption ? { caption } : {}),
                    ...(recipient ? { user: recipient } : {}),
                },
            };
        case 'max': {
            // ioBroker.max: a positive number is a user, a negative one a group chat, empty = all known users
            /** @type {Record<string, unknown>} */
            const message = {
                ...(caption ? { text: caption } : {}),
                [result.format === 'mp4' ? 'video' : 'image']: result.file,
            };
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
                    subject: caption || `${result.camera}: ${result.format === 'jpg' ? 'snapshot' : 'clip'}`,
                    text: textOnly(result, caption),
                    attachments: [{ filename: path.basename(result.file), path: result.file }],
                },
            };
        case 'pushover':
            // Pushover attaches pictures only
            return {
                command: 'send',
                message: {
                    message: textOnly(result, caption),
                    ...(image ? { file: result.file } : {}),
                    ...(recipient ? { device: recipient } : {}),
                },
            };
        case 'discord': {
            /** @type {Record<string, unknown>} */
            const message = {
                content: {
                    content: caption || textOnly(result, caption),
                    files: [{ attachment: result.file, name: path.basename(result.file) }],
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
            return image
                ? {
                      command: 'send',
                      message: { file: `file://${result.file.replace(/\\/g, '/').replace(/^(?!\/)/, '/')}` },
                  }
                : { command: 'send', message: textOnly(result, caption) };
        case 'signal-cmb':
        case 'whatsapp-cmb':
            return {
                command: 'send',
                message: { text: textOnly(result, caption), ...(recipient ? { phone: recipient } : {}) },
            };
        case 'gotify':
            return {
                command: 'send',
                message: { title: caption || result.camera, message: textOnly(result, caption) },
            };
        case 'ntfy':
            return {
                command: 'send',
                message: {
                    title: caption || result.camera,
                    message: textOnly(result, caption),
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

module.exports = { KNOWN, buildMessage, textOnly };
