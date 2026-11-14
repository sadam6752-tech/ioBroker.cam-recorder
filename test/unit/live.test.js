'use strict';

// The live picture from the pre-recording (column Live of the tab Cameras), with the bundled ffmpeg and a local test
// video as camera.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { FfmpegRunner, resolveFfmpegPath } = require('../../lib/ffmpeg-runner');
const { Prebuffer } = require('../../lib/prebuffer');
const { LivePicture } = require('../../lib/live');
const { normalizeSettings, normalizeCameras } = require('../../lib/config');

const ffmpegPath = String(resolveFfmpegPath(''));
const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) };

describe('live picture', function () {
    this.timeout(120_000);
    let dir;
    let source;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-live-'));
        source = path.join(dir, 'live.ts');
        execFileSync(ffmpegPath, [
            ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '20'],
            ...['-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-y', source],
        ]);
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads the column Live, 0 = off', () => {
        const rows = [5, 0, 120, undefined].map((live, i) => ({ name: `c${i}`, url: 'rtsp://h/s', live }));
        assert.deepEqual(
            normalizeCameras(rows).cameras.map(c => c.live),
            [5, 0, 60, 0],
        );
    });

    it('writes the newest key frame of the pre-recording, turned, and the same frame only once', async () => {
        const camera = {
            id: 'cam',
            name: 'Cam',
            url: source,
            username: '',
            password: '',
            transport: /** @type {const} */ ('tcp'),
            keyframesOnly: false,
            prebuffer: 3,
            orientation: /** @type {const} */ ('90'),
            live: 2,
        };
        const buffer = new Prebuffer({
            camera,
            settings: normalizeSettings({ rtspTimeout: 2 }),
            seconds: 3,
            dir: path.join(dir, 'buffer'),
            ffmpegPath,
            timers,
        });
        /** @type {Buffer[]} */
        const written = [];
        const live = new LivePicture({
            camera,
            buffer,
            runner: new FfmpegRunner({ ffmpegPath, maxParallel: 1, timers }),
            seconds: 2,
            width: 0,
            timers,
            write: async data => {
                written.push(data);
            },
        });
        // no pre-recording yet: nothing to take
        assert.equal(await live.tick(), false);
        await buffer.start();
        try {
            const end = Date.now() + 20_000;
            while (!buffer.isRunning()) {
                assert.ok(Date.now() < end, 'the buffer did not start');
                await new Promise(r => setTimeout(r, 200));
            }
            assert.equal(await live.tick(), true);
            const file = path.join(dir, 'first.jpg');
            fs.writeFileSync(file, written[0]);
            const out = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
            assert.match(out, /240x320/, 'turned by 90°');
            // the same key frame again is not written a second time
            live.last = written[0];
            const again = await live.grab();
            if (again && again.equals(written[0])) {
                assert.equal(await live.tick(), false);
            }
            // no file of the live picture is left in the buffer folder
            assert.deepEqual(
                fs.readdirSync(buffer.dir).filter(n => !n.endsWith('.mkv')),
                [],
            );
        } finally {
            live.stop();
            await buffer.stop();
        }
    });
});
