'use strict';

// Turning the picture (column ↻ of the tab Cameras) and the month folders (tabs Storage and NAS). The recordings run
// the bundled ffmpeg for real; a local test video stands in for the camera.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { FfmpegRunner, resolveFfmpegPath } = require('../../lib/ffmpeg-runner');
const { Recorder } = require('../../lib/recorder');
const { Prebuffer } = require('../../lib/prebuffer');
const { normalizeSettings, normalizeCameras } = require('../../lib/config');
const { clipArgs, snapshotArgs, copyInputArgs } = require('../../lib/ffmpeg-args');
const { normalizeOrientation, orientFilter, displayArgs, supportsDisplayMatrix } = require('../../lib/orientation');
const { cameraFolder, monthName, removePartials } = require('../../lib/storage');
const { remoteMonth } = require('../../lib/remote-copy');

const ffmpegPath = String(resolveFfmpegPath(''));
const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) };

/**
 * @param {string} file - Media file
 * @returns {{size: string, rotation: string | null}} Size of the video stream and the rotation of its display matrix
 */
function probe(file) {
    const out = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
    const video = out.split('\n').find(line => / Video: /.test(line)) || '';
    const size = /, (\d{2,5}x\d{2,5})[ ,]/.exec(video);
    const rotation = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(out);
    return { size: size ? size[1] : '', rotation: rotation ? rotation[1] : null };
}

describe('orientation of a camera', () => {
    it('reads the column ↻, anything unknown is 0°', () => {
        const rows = ['90', '180', '270', 'hflip', 'vflip', '45', undefined].map((orientation, i) => ({
            name: `c${i}`,
            url: 'rtsp://h/s',
            orientation,
        }));
        assert.deepEqual(
            normalizeCameras(rows).cameras.map(c => c.orientation),
            ['90', '180', '270', 'hflip', 'vflip', '0', '0'],
        );
        assert.equal(normalizeOrientation(90), '90');
    });

    it('turns clockwise with a filter, or with a display matrix for a copied stream', () => {
        assert.equal(orientFilter('0'), '');
        assert.equal(orientFilter('90'), 'transpose=1');
        assert.equal(orientFilter('270'), 'transpose=2');
        assert.equal(orientFilter('180'), 'hflip,vflip');
        assert.equal(orientFilter('hflip'), 'hflip');
        // -display_rotation turns counter-clockwise
        assert.deepEqual(displayArgs('90'), ['-display_rotation', '-90']);
        assert.deepEqual(displayArgs('270'), ['-display_rotation', '90']);
        assert.deepEqual(displayArgs('vflip'), ['-display_vflip']);
        assert.deepEqual(displayArgs('0'), []);
    });

    it('turns before scaling and only marks a copied mp4', () => {
        const base = { duration: 2, width: 320, fps: 0, orientation: /** @type {const} */ ('90') };
        const mp4 = clipArgs({ ...base, format: 'mp4', mode: 'transcode' }, 'x.mp4');
        assert.equal(mp4[mp4.indexOf('-vf') + 1], 'setpts=PTS-STARTPTS,transpose=1,scale=320:-2');
        const gif = clipArgs({ ...base, format: 'gif', mode: 'transcode' }, 'x.gif');
        assert.match(gif[gif.indexOf('-vf') + 1], /^setpts=PTS-STARTPTS,transpose=1,scale=320:-1/);
        const copy = { ...base, format: /** @type {const} */ ('mp4'), mode: /** @type {const} */ ('copy') };
        assert.ok(!clipArgs(copy, 'x.mp4').includes('-vf'));
        assert.deepEqual(copyInputArgs(copy), ['-display_rotation', '-90']);
        assert.deepEqual(copyInputArgs({ ...copy, mode: 'transcode' }), []);
        const jpg = snapshotArgs(0, 'x.jpg', 'hflip');
        assert.equal(jpg[jpg.indexOf('-vf') + 1], 'hflip');
        assert.ok(!snapshotArgs(0, 'x.jpg').includes('-vf'));
    });

    it('knows which ffmpeg can mark a copied stream', () => {
        assert.equal(supportsDisplayMatrix('ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright'), true);
        assert.equal(supportsDisplayMatrix('ffmpeg version n7.0.2 Copyright'), true);
        assert.equal(supportsDisplayMatrix('ffmpeg version 5.1.6-0+deb12u1 Copyright'), false);
        assert.equal(supportsDisplayMatrix('ffmpeg version 4.4.2-0ubuntu0.22.04.1'), false);
        // a git build has no version number
        assert.equal(supportsDisplayMatrix('ffmpeg version N-112345-g0123abcd Copyright'), true);
    });
});

describe('turned recordings (real ffmpeg)', function () {
    this.timeout(120_000);
    let dir;
    let source;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-turn-'));
        source = path.join(dir, 'source.ts');
        execFileSync(ffmpegPath, [
            ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '20'],
            ...['-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-y', source],
        ]);
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @param {import('../../lib/types').Orientation} orientation - Turning
     * @returns {import('../../lib/types').Camera} Camera reading the test file
     */
    const camera = orientation => ({
        id: 'cam',
        name: 'Cam',
        url: source,
        username: '',
        password: '',
        transport: 'tcp',
        keyframesOnly: false,
        prebuffer: 3,
        orientation,
    });

    /**
     * @param {Record<string, any>} native - Settings
     * @returns {Recorder} Recorder writing into a fresh folder
     */
    function recorder(native) {
        return new Recorder({
            runner: new FfmpegRunner({ ffmpegPath, maxParallel: 2, timers }),
            outputDir: fs.mkdtempSync(path.join(dir, 'out-')),
            settings: normalizeSettings({ rtspTimeout: 2, videoWidth: 0, ...native }),
            withPassword: c => c,
        });
    }

    it('turns snapshots, gifs and re-encoded clips', async () => {
        const rec = recorder({});
        assert.equal(probe((await rec.snapshot(camera('90'))).file).size, '240x320');
        assert.equal(probe((await rec.snapshot(camera('hflip'), { width: 160 })).file).size, '160x120');
        assert.equal(probe((await rec.record(camera('270'), { duration: 1 })).file).size, '240x320');
        assert.equal(probe((await rec.record(camera('180'), { duration: 1 })).file).size, '320x240');
        const gif = await rec.record(camera('90'), { duration: 1, format: 'gif', width: 120 });
        assert.equal(probe(gif.file).size, '120x160');
    });

    it('marks a copied mp4 as turned, also a clip from the pre-recording', async () => {
        const live = await recorder({ videoMode: 'copy' }).record(camera('90'), { duration: 1 });
        assert.deepEqual(probe(live.file), { size: '320x240', rotation: '-90.00' });

        const settings = normalizeSettings({ rtspTimeout: 2, videoMode: 'copy' });
        const buffer = new Prebuffer({
            camera: camera('270'),
            settings,
            seconds: 3,
            dir: path.join(dir, 'buffer'),
            ffmpegPath,
            timers,
        });
        await buffer.start();
        try {
            const end = Date.now() + 20_000;
            while (!buffer.isRunning()) {
                assert.ok(Date.now() < end, 'the buffer did not start');
                await new Promise(r => setTimeout(r, 200));
            }
            await new Promise(r => setTimeout(r, 4000));
            const rec = new Recorder({
                runner: new FfmpegRunner({ ffmpegPath, maxParallel: 2, timers }),
                outputDir: fs.mkdtempSync(path.join(dir, 'out-')),
                settings,
                withPassword: c => c,
                getPrebuffer: () => buffer,
            });
            const clip = await rec.record(camera('270'), { duration: 1 });
            assert.ok(clip.fromBuffer);
            assert.equal(probe(clip.file).rotation, '90.00');
            // a picture of the buffer is turned for real
            const jpg = await rec.snapshot(camera('270'));
            assert.ok(jpg.fromBuffer);
            assert.equal(probe(jpg.file).size, '240x320');
        } finally {
            await buffer.stop();
        }
    });

    it('re-encodes a copied clip of a turned camera when ffmpeg is older than 6.0', async () => {
        const rec = recorder({ videoMode: 'copy' });
        rec.settings.displayMatrix = false;
        const clip = await rec.record(camera('90'), { duration: 1 });
        assert.deepEqual(probe(clip.file), { size: '240x320', rotation: null });
    });

    it('sorts into month folders and keeps every file', async () => {
        const rec = recorder({ monthFolders: true, keepFiles: 1, maxAgeDays: 1 });
        assert.equal(rec.settings.keepFiles, 0);
        assert.equal(rec.settings.maxAgeDays, 0);
        const a = await rec.snapshot(camera('0'));
        const b = await rec.snapshot(camera('0'));
        const folder = path.join(rec.outputDir, 'cam', monthName(new Date(a.time)));
        assert.equal(path.dirname(a.file), folder);
        assert.ok(fs.existsSync(a.file) && fs.existsSync(b.file), 'keepFiles 1 must not delete with month folders');
    });
});

describe('month folders', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-month-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('names the folder of a file by camera and local month', () => {
        const date = new Date(2026, 0, 31, 23, 59, 59);
        assert.equal(cameraFolder(dir, 'door', true, date), path.join(dir, 'door', '2026-01'));
        assert.equal(cameraFolder(dir, 'door', false, date), dir);
    });

    it('removes leftover .part files also in month folders', async () => {
        const month = path.join(dir, 'door', '2026-11');
        fs.mkdirSync(month, { recursive: true });
        fs.writeFileSync(path.join(month, 'door_2026-11-13_10-00-00.mp4.part'), 'x');
        fs.writeFileSync(path.join(month, 'door_2026-11-13_09-00-00.mp4'), 'x');
        fs.writeFileSync(path.join(dir, 'door_2026-11-13_08-00-00.jpg.part'), 'x');
        assert.equal(await removePartials(dir), 2);
        assert.deepEqual(fs.readdirSync(month), ['door_2026-11-13_09-00-00.mp4']);
    });

    it('takes the month on the server from the file name, so it matches the local folder', () => {
        assert.equal(remoteMonth('door_2026-10-31_23-59-58.mp4', Date.UTC(2026, 10, 1)), '2026-10');
        assert.equal(remoteMonth('door_2026-10-31_23-59-58-2.jpg'), '2026-10');
        assert.equal(remoteMonth('door_timelapse_2026-09-30.mp4'), '2026-09');
        assert.equal(remoteMonth('door_timelapse_2026-09-30-2.mp4'), '2026-09');
        assert.equal(remoteMonth('other.mp4', new Date(2026, 4, 2).getTime()), '2026-05');
    });

    it('switches off the limits of the server with month folders on the server', () => {
        const on = normalizeSettings({ remoteMonthFolders: true, remoteKeepDays: 30 }).remote;
        assert.deepEqual([on.monthFolders, on.keepDays], [true, 0]);
        const off = normalizeSettings({ remoteKeepDays: 30 }).remote;
        assert.deepEqual([off.monthFolders, off.keepDays], [false, 30]);
    });
});
