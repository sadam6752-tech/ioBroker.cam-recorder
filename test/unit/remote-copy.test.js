'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    isOwnFile,
    normalizeRemoteDirectory,
    remoteSettingsProblems,
    hostKeyMatches,
    hexToFingerprint,
    selectExpired,
    selectStalePartials,
    copyFileToRemote,
    settingsForConnectionTest,
    testRemoteConnection,
} = require('../../lib/remote-copy');
const { connectSsh2 } = require('../../lib/sftp-ssh2');
const { startServer } = require('../helpers/sftp-server');

const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) };
const log = { warn: () => undefined };

/**
 * @param {Partial<import('../../lib/types').RemoteSettings>} [extra] - Overrides
 * @returns {import('../../lib/types').RemoteSettings} Settings
 */
const settings = (extra = {}) => ({
    enabled: true,
    host: '127.0.0.1',
    port: 22,
    username: 'nas',
    password: 'secret',
    directory: '/cam-recorder',
    hostKey: '',
    keepDays: 0,
    ...extra,
});

describe('SFTP copy: rules', () => {
    it('knows its own file names', () => {
        assert.ok(isOwnFile('door_2026-10-18_09-00-00.mp4'));
        assert.ok(isOwnFile('door_2026-10-18_09-00-00-2.jpg'));
        assert.ok(isOwnFile('front_door_timelapse_2026-10-18.mp4'));
        assert.ok(!isOwnFile('notes.txt'));
        assert.ok(!isOwnFile('door_2026-10-18_09-00-00.mkv'));
    });

    it('normalizes the directory and refuses ..', () => {
        assert.equal(normalizeRemoteDirectory(' /volume1//cams/ '), '/volume1/cams');
        assert.equal(normalizeRemoteDirectory('cams\\door'), 'cams/door');
        assert.equal(normalizeRemoteDirectory('/a/../b'), null);
    });

    it('names missing settings', () => {
        assert.deepEqual(remoteSettingsProblems({}), [
            'the host is missing',
            'the user name is missing',
            'the password is missing',
        ]);
    });

    it('compares fingerprints in the OpenSSH and the hex form', () => {
        const hex = 'ab'.repeat(32);
        assert.ok(hostKeyMatches(hexToFingerprint(hex), hex));
        assert.ok(hostKeyMatches(hex.match(/../g).join(':'), hex));
        assert.ok(!hostKeyMatches(hexToFingerprint('cd'.repeat(32)), hex));
        assert.ok(hostKeyMatches('', hex));
    });

    it('deletes only own files older than the maximum age, and own leftovers', () => {
        const now = new Date(2026, 9, 18, 12, 0, 0).getTime();
        const names = [
            'door_2026-10-01_09-00-00.mp4',
            'door_timelapse_2026-10-01.mp4',
            'door_2026-10-17_09-00-00.mp4',
            'holiday_2026-10-01.mp4',
            'door_2026-10-01_09-00-00.mp4.part',
            'other.part',
        ];
        assert.deepEqual(selectExpired(names, 7, now), [
            'door_2026-10-01_09-00-00.mp4',
            'door_timelapse_2026-10-01.mp4',
        ]);
        assert.deepEqual(selectExpired(names, 0, now), []);
        assert.deepEqual(selectStalePartials(names), ['door_2026-10-01_09-00-00.mp4.part']);
    });

    it('uses the saved password in the connection test only for the saved server', () => {
        const saved = settings({ host: 'nas.local', password: 'stored' });
        const same = settingsForConnectionTest({ remoteHost: 'nas.local', remotePassword: '' }, saved);
        assert.equal(same.password, 'stored');
        const other = settingsForConnectionTest({ remoteHost: 'evil.example', remotePassword: '' }, saved);
        assert.equal(other.password, '');
        const typed = settingsForConnectionTest({ remoteHost: 'evil.example', remotePassword: 'typed' }, saved);
        assert.equal(typed.password, 'typed');
    });
});

describe('SFTP copy: real server', function () {
    this.timeout(60_000);
    /** @type {{files: Map<string, Buffer>, directories: Set<string>}} */
    let disk;
    /** @type {{port: number, fingerprint: string, close: () => void}} */
    let server;
    let dir;

    beforeEach(async () => {
        disk = { files: new Map(), directories: new Set() };
        server = await startServer(disk);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-sftp-'));
    });

    afterEach(() => {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('copies a file into the folder of its camera, completely and under its final name', async () => {
        const file = path.join(dir, 'door_2026-10-18_09-00-00.mp4');
        const data = Buffer.alloc(200_000, 7);
        fs.writeFileSync(file, data);
        const result = await copyFileToRemote(
            connectSsh2,
            settings({ port: server.port, hostKey: server.fingerprint }),
            { file, cameraId: 'door' },
            log,
            timers,
        );
        assert.equal(result.ok, true, result.message);
        assert.equal(result.remoteFile, '/cam-recorder/door/door_2026-10-18_09-00-00.mp4');
        assert.deepEqual(disk.files.get(result.remoteFile), data);
        assert.deepEqual(
            [...disk.files.keys()].filter(k => k.endsWith('.part')),
            [],
        );
    });

    it('deletes old own files on the server but not foreign ones', async () => {
        disk.directories.add('/cam-recorder');
        disk.directories.add('/cam-recorder/door');
        disk.files.set('/cam-recorder/door/door_2020-01-01_09-00-00.mp4', Buffer.from('old'));
        disk.files.set('/cam-recorder/door/my-video.mp4', Buffer.from('foreign'));
        const file = path.join(dir, 'door_2026-10-18_09-00-00.jpg');
        fs.writeFileSync(file, 'new');
        const result = await copyFileToRemote(
            connectSsh2,
            settings({ port: server.port, keepDays: 30 }),
            { file, cameraId: 'door' },
            log,
            timers,
        );
        assert.equal(result.ok, true, result.message);
        assert.deepEqual(result.deleted, ['door_2020-01-01_09-00-00.mp4']);
        assert.ok(disk.files.has('/cam-recorder/door/my-video.mp4'));
    });

    it('refuses a server with another fingerprint before sending the password, and a wrong password', async () => {
        const file = path.join(dir, 'door_2026-10-18_09-00-00.jpg');
        fs.writeFileSync(file, 'x');
        const wrongKey = await copyFileToRemote(
            connectSsh2,
            settings({ port: server.port, hostKey: hexToFingerprint('00'.repeat(32)) }),
            { file, cameraId: 'door' },
            log,
            timers,
        );
        assert.equal(wrongKey.ok, false);
        assert.match(wrongKey.message, /does not match the fingerprint/);
        const wrongPassword = await copyFileToRemote(
            connectSsh2,
            settings({ port: server.port, password: 'nope' }),
            { file, cameraId: 'door' },
            log,
            timers,
        );
        assert.equal(wrongPassword.ok, false);
        assert.equal(disk.files.size, 0);
    });

    it('tests the connection and reports the fingerprint', async () => {
        const result = await testRemoteConnection(connectSsh2, settings({ port: server.port }), timers);
        assert.equal(result.ok, true, result.message);
        assert.equal(result.fingerprint, server.fingerprint);
        assert.equal(disk.files.size, 0, 'the probe file is removed');
    });
});
