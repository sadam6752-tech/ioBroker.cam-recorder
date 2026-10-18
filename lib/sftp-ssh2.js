'use strict';

/**
 * The real SFTP connection for `remote-copy.js`, made with the `ssh2` library (pure JavaScript,
 * no subprocess, no mount). Same as in ioBroker.fingerprint and ioBroker.e-invoices.
 */

const { Client } = require('ssh2');
const { hexToFingerprint, hostKeyMatches } = require('./remote-copy');

/**
 * @typedef {import('./remote-copy').SftpSession} SftpSession
 * @typedef {import('./remote-copy').Connection} Connection
 */

/** Longest time the server may take to answer the SSH handshake. */
const READY_TIMEOUT_MS = 20_000;

/**
 * Calls an SFTP method that reports through a node-style callback.
 *
 * @template T
 * @param {(done: (error: Error | null | undefined, value?: T) => void) => void} run - The call
 * @returns {Promise<T>} The value
 */
function call(run) {
    return new Promise((resolve, reject) => {
        run((error, value) => (error ? reject(error) : resolve(/** @type {T} */ (value))));
    });
}

/**
 * @param {import('ssh2').Client} client - SSH client
 * @param {import('ssh2').SFTPWrapper} sftp - SFTP channel
 * @returns {SftpSession} The session
 */
function sessionOf(client, sftp) {
    return {
        async makeDirectories(directory) {
            const absolute = directory.startsWith('/');
            let current = absolute ? '' : '.';
            for (const part of directory.split('/').filter(Boolean)) {
                current = current === '.' ? part : `${current}/${part}`;
                const dir = absolute && !current.startsWith('/') ? `/${current}` : current;
                try {
                    await call(done => sftp.stat(dir, done));
                } catch {
                    // missing: create it (a failure here is a real one, e.g. no permission)
                    await call(done => sftp.mkdir(dir, done));
                }
            }
        },
        writeFile: (file, data) => call(done => sftp.writeFile(file, data, done)),
        size: async file => (await call(done => sftp.stat(file, done))).size,
        rename: (from, to) => call(done => sftp.rename(from, to, done)),
        list: async directory => (await call(done => sftp.readdir(directory, done))).map(entry => entry.filename),
        remove: file => call(done => sftp.unlink(file, done)),
        close: () => {
            client.end();
        },
    };
}

/**
 * Connects to an SFTP server with user name and password. A fingerprint entered in the settings is
 * checked while connecting: a different server is refused before the password is sent.
 *
 * @param {Connection} settings - Server, login and the expected host key
 * @returns {Promise<SftpSession>} The open session
 */
const connectSsh2 = settings =>
    new Promise((resolve, reject) => {
        const client = new Client();
        /** @type {Error | undefined} */
        let refused;
        client.on('ready', () => {
            client.sftp((error, sftp) => {
                if (error) {
                    client.end();
                    reject(error);
                    return;
                }
                resolve(sessionOf(client, sftp));
            });
        });
        client.on('error', error => {
            reject(refused ?? error);
        });
        client.on('close', () => {
            reject(refused ?? new Error('the server closed the connection'));
        });
        client.connect({
            host: settings.host,
            port: settings.port,
            username: settings.username,
            password: settings.password,
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: 15_000,
            hostHash: 'sha256',
            hostVerifier: (/** @type {string} */ hash) => {
                settings.onHostKey(hexToFingerprint(hash));
                if (hostKeyMatches(settings.hostKey, hash)) {
                    return true;
                }
                refused = new Error(
                    `the host key of the server does not match the fingerprint in the settings (the server shows ${hexToFingerprint(hash)})`,
                );
                return false;
            },
        });
    });

module.exports = { connectSsh2 };
