'use strict';

const assert = require('node:assert/strict');
const { maskSecrets } = require('../../lib/mask');
const { splitCredentials, buildInputUrl, isRtsp } = require('../../lib/camera-url');
const { protectCameras, revealPassword, isProtected } = require('../../lib/secrets');
const { cameraId, normalizeCameras, normalizeTriggers, normalizeSettings, findCamera } = require('../../lib/config');
const { inputArgs, clipArgs, snapshotArgs } = require('../../lib/ffmpeg-args');
const { isTruthy, shouldFire, formatCaption, formatDay } = require('../../lib/triggers');

const fakeEncrypt = v => `E(${Buffer.from(v).toString('base64')})`;
const fakeDecrypt = v => Buffer.from(v.slice(2, -1), 'base64').toString();

describe('maskSecrets', () => {
    it('hides the login of every URL', () => {
        const text = 'rtsp://admin:Secret@192.168.1.20:554/mpeg/media.amp: Connection refused';
        const out = maskSecrets(text);
        assert.equal(out, 'rtsp://***:***@192.168.1.20:554/mpeg/media.amp: Connection refused');
    });

    it('hides a password with an @ and its encoded form anywhere in the text', () => {
        const pw = 'p@ss/w:rd';
        const text = `rtsp://u:${pw}@host/x failed, auth "${pw}" and ${encodeURIComponent(pw)}`;
        const out = maskSecrets(text, [pw]);
        assert.ok(!out.includes(pw), out);
        assert.ok(!out.includes(encodeURIComponent(pw)), out);
    });

    it('does not replace secrets shorter than three characters outside of URLs', () => {
        assert.equal(maskSecrets('a b c', ['a']), 'a b c');
    });
});

describe('camera URL', () => {
    it('splits a login from the URL, also with an @ in the password', () => {
        assert.deepEqual(splitCredentials('rtsp://admin:pa@ss@192.168.1.20:554/mpeg/media.amp'), {
            url: 'rtsp://192.168.1.20:554/mpeg/media.amp',
            username: 'admin',
            password: 'pa@ss',
        });
    });

    it('decodes a percent-encoded login', () => {
        assert.equal(splitCredentials('rtsp://a%40b:p%2Fw@host/x').password, 'p/w');
        assert.equal(splitCredentials('rtsp://a%40b:p%2Fw@host/x').username, 'a@b');
    });

    it('leaves a URL without login unchanged', () => {
        assert.deepEqual(splitCredentials(' rtsp://host:554/path '), {
            url: 'rtsp://host:554/path',
            username: '',
            password: '',
        });
    });

    it('builds an encoded input URL that splits back to the same login', () => {
        const url = buildInputUrl('rtsp://host/x', 'us er', 'p@ss:/?#');
        assert.equal(url, `rtsp://us%20er:${encodeURIComponent('p@ss:/?#')}@host/x`);
        const back = splitCredentials(url);
        assert.equal(back.username, 'us er');
        assert.equal(back.password, 'p@ss:/?#');
    });

    it('keeps a local file path as it is', () => {
        assert.equal(buildInputUrl('/tmp/test.mp4', 'u', 'p'), '/tmp/test.mp4');
        assert.equal(isRtsp('/tmp/test.mp4'), false);
        assert.equal(isRtsp('RTSPS://host'), true);
    });
});

describe('camera passwords', () => {
    it('moves a login out of the URL and encrypts the password', () => {
        const { changed, cameras } = protectCameras(
            [{ name: 'Entrance', url: 'rtsp://admin:secret@1.2.3.4/x', username: '', password: '' }],
            fakeEncrypt,
        );
        assert.equal(changed, true);
        assert.equal(cameras[0].url, 'rtsp://1.2.3.4/x');
        assert.equal(cameras[0].username, 'admin');
        assert.ok(isProtected(cameras[0].password));
        assert.ok(!JSON.stringify(cameras).includes('secret'));
        assert.equal(revealPassword(cameras[0].password, fakeDecrypt), 'secret');
    });

    it('changes nothing on the second start', () => {
        const first = protectCameras([{ url: 'rtsp://h/x', password: 'pw' }], fakeEncrypt);
        const second = protectCameras(first.cameras, fakeEncrypt);
        assert.equal(second.changed, false);
        assert.deepEqual(second.cameras, first.cameras);
    });

    it('passes a plain value through revealPassword (before the migration ran)', () => {
        assert.equal(revealPassword('plain', fakeDecrypt), 'plain');
        assert.equal(revealPassword('', fakeDecrypt), '');
    });
});

describe('configuration', () => {
    it('builds object ids from camera names', () => {
        assert.equal(cameraId('Zürich Gate'), 'zuerich_gate');
        assert.equal(cameraId('  Garage (left) '), 'garage_left');
        assert.equal(cameraId('***'), '');
    });

    it('skips inactive, nameless, duplicate and URL-less cameras with a reason', () => {
        const { cameras, problems } = normalizeCameras([
            { name: 'Entrance', url: 'rtsp://h/1' },
            { name: 'entrance', url: 'rtsp://h/2' },
            { name: '', url: 'rtsp://h/3' },
            { name: 'Garden', url: 'rtsp://' },
            { name: 'Aus', url: 'rtsp://h/4', enabled: false },
        ]);
        assert.deepEqual(
            cameras.map(c => c.id),
            ['entrance'],
        );
        assert.equal(problems.length, 3);
        assert.equal(cameras[0].transport, 'tcp');
    });

    it('finds a camera by name or id, case does not matter', () => {
        const { cameras } = normalizeCameras([{ name: 'Zürich Gate', url: 'rtsp://h/1' }]);
        assert.equal(findCamera(cameras, 'ZÜRICH GATE')?.id, 'zuerich_gate');
        assert.equal(findCamera(cameras, 'zuerich_gate')?.id, 'zuerich_gate');
        assert.equal(findCamera(cameras, 'nope'), undefined);
    });

    it('drops triggers of unknown cameras and fills defaults', () => {
        const { cameras } = normalizeCameras([{ name: 'Entrance', url: 'rtsp://h/1' }]);
        const { triggers, problems } = normalizeTriggers(
            [
                { stateId: 'doorbird.0.Doorbell.1.trigger', camera: 'Entrance' },
                { stateId: 'x.0.y', camera: 'Garden' },
                { stateId: '', camera: 'Entrance' },
            ],
            cameras,
        );
        assert.equal(triggers.length, 1);
        assert.equal(problems.length, 2);
        assert.deepEqual(
            { ...triggers[0], camera: triggers[0].camera.id },
            {
                stateId: 'doorbird.0.Doorbell.1.trigger',
                camera: 'entrance',
                action: 'record',
                duration: 0,
                format: '',
                condition: 'truthy',
                cooldown: 10,
                telegram: true,
            },
        );
    });

    it('applies limits to the settings', () => {
        const s = normalizeSettings({ recordDuration: 999, maxParallel: 0, videoWidth: 'abc', recordFormat: 'avi' });
        assert.equal(s.recordDuration, 60);
        assert.equal(s.maxParallel, 1);
        assert.equal(s.videoWidth, 640);
        assert.equal(s.recordFormat, 'mp4');
    });
});

/** @returns {boolean} True when the gif filter also resets the clock first */
function gifArgsStartAtFirstPicture() {
    const gif = clipArgs({ duration: 3, format: 'gif', mode: 'transcode', width: 480, fps: 8 }, 'x');
    return gif[gif.indexOf('-vf') + 1].startsWith('setpts=PTS-STARTPTS,');
}

describe('ffmpeg arguments', () => {
    const settings = normalizeSettings({});
    const camera = {
        id: 'entrance',
        name: 'Entrance',
        url: 'rtsp://1.2.3.4/x',
        username: 'u',
        password: 'p',
        transport: /** @type {'tcp'} */ ('tcp'),
        keyframesOnly: true,
    };

    it('opens RTSP over TCP with a socket timeout', () => {
        const args = inputArgs(camera, settings);
        assert.deepEqual(args.slice(args.indexOf('-rtsp_transport'), args.indexOf('-rtsp_transport') + 4), [
            '-rtsp_transport',
            'tcp',
            '-timeout',
            '10000000',
        ]);
        assert.equal(args[args.length - 1], 'rtsp://u:p@1.2.3.4/x');
        assert.ok(!args.includes('-skip_frame'));
    });

    it('skips to key frames only for a snapshot when asked', () => {
        assert.ok(inputArgs(camera, settings, { snapshot: true }).includes('nokey'));
    });

    it('builds an mp4, a copied mp4 and a gif', () => {
        const mp4 = clipArgs({ duration: 5, format: 'mp4', mode: 'transcode', width: 640, fps: 10 }, 'out.part');
        assert.ok(mp4.includes('libx264') && mp4.includes('yuv420p'));
        // the clip length starts at the first picture, then the picture is scaled
        assert.ok(mp4.includes('setpts=PTS-STARTPTS,scale=640:-2'), mp4.join(' '));
        assert.ok(gifArgsStartAtFirstPicture());
        const copy = clipArgs({ duration: 5, format: 'mp4', mode: 'copy', width: 640, fps: 10 }, 'out.part');
        assert.ok(copy.includes('copy') && !copy.includes('libx264') && !copy.join(' ').includes('scale'));
        const gif = clipArgs({ duration: 3, format: 'gif', mode: 'transcode', width: 480, fps: 8 }, 'out.part');
        assert.ok(gif.join(' ').includes('palettegen') && gif.includes('gif'));
        assert.equal(gif[gif.length - 1], 'out.part');
    });

    it('builds a snapshot with and without scaling', () => {
        assert.ok(snapshotArgs(320, 'a.part').includes('scale=320:-2'));
        assert.ok(!snapshotArgs(0, 'a.part').includes('-vf'));
    });
});

describe('triggers', () => {
    const trigger = /** @type {any} */ ({ condition: 'truthy', cooldown: 10 });

    it('knows truthy values', () => {
        for (const v of [true, 1, 'true', 'on', 'ring']) {
            assert.equal(isTruthy(v), true, String(v));
        }
        for (const v of [false, 0, '', 'false', '0', 'off', null, undefined]) {
            assert.equal(isTruthy(v), false, String(v));
        }
    });

    it('fires on every write of a truthy value outside of the cooldown', () => {
        const state = /** @type {any} */ ({ val: true, ack: true });
        assert.equal(shouldFire(trigger, state, 0, 1000), true);
        assert.equal(shouldFire(trigger, state, 1000, 5000), false);
        assert.equal(shouldFire(trigger, state, 1000, 11_000), true);
        assert.equal(shouldFire(trigger, { ...state, val: false }, 0, 1000), false);
        assert.equal(shouldFire({ ...trigger, condition: 'any' }, { ...state, val: false }, 0, 1000), true);
        assert.equal(shouldFire(trigger, null, 0, 1000), false);
    });

    it('fills the caption', () => {
        assert.equal(formatCaption('{camera} {time}', 'Entrance', new Date(2026, 0, 2, 7, 5, 9)), 'Entrance 07:05:09');
        assert.equal(
            formatCaption('{camera} {date} {time}', 'DoorBird', new Date(2026, 9, 17, 13, 22, 12), 'DD.MM.YYYY'),
            'DoorBird 17.10.2026 13:22:12',
        );
    });

    it('writes the date in the system date format', () => {
        const day = new Date(2026, 2, 5);
        assert.equal(formatDay(day), '05.03.2026');
        assert.equal(formatDay(day, 'YYYY-MM-DD'), '2026-03-05');
        assert.equal(formatDay(day, 'MM/DD/YYYY'), '03/05/2026');
        assert.equal(formatDay(day, 'TT.MM.JJJJ'), '05.03.2026');
        assert.equal(formatDay(day, 'DD.MM.YY'), '05.03.26');
    });
});
