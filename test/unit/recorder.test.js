'use strict';

// These tests run the bundled ffmpeg for real. A local test video stands in for the camera.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { FfmpegRunner, probeFfmpeg, resolveFfmpegPath, mediaDuration } = require('../../lib/ffmpeg-runner');
const { Recorder } = require('../../lib/recorder');
const { normalizeSettings } = require('../../lib/config');
const { uniqueFile, pruneFiles, removePartials, timeStamp } = require('../../lib/storage');

const ffmpegPath = resolveFfmpegPath('');
const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) };

/**
 * @param {string} url - Input
 * @param {Partial<import('../../lib/types').Camera>} [extra] - Overrides
 * @returns {import('../../lib/types').Camera} Camera
 */
function camera(url, extra = {}) {
    return {
        id: 'cam',
        name: 'Cam',
        url,
        username: '',
        password: '',
        transport: 'tcp',
        keyframesOnly: false,
        ...extra,
    };
}

describe('ffmpeg runner and recorder (real ffmpeg)', function () {
    this.timeout(120_000);
    let dir;
    let source;

    before(() => {
        assert.ok(ffmpegPath, 'ffmpeg-static must provide a binary');
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-test-'));
        source = path.join(dir, 'source.mp4');
        execFileSync(ffmpegPath, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=640x360:rate=15',
            '-t',
            '6',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-y',
            source,
        ]);
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @param {Record<string, any>} [native] - Settings
     * @param {number} [maxParallel] - Processes at the same time
     * @returns {{recorder: Recorder, out: string}} Recorder writing into a fresh folder
     */
    function makeRecorder(native = {}, maxParallel = 2) {
        const out = fs.mkdtempSync(path.join(dir, 'out-'));
        const runner = new FfmpegRunner({ ffmpegPath: String(ffmpegPath), maxParallel, timers });
        const recorder = new Recorder({
            runner,
            outputDir: out,
            settings: normalizeSettings({ rtspTimeout: 2, ...native }),
            withPassword: c => c,
        });
        return { recorder, out };
    }

    it('reads the version of the bundled ffmpeg', async () => {
        const version = await probeFfmpeg(String(ffmpegPath));
        assert.match(version, /^ffmpeg version /);
    });

    it('records an mp4 clip and leaves no .part file', async () => {
        const { recorder, out } = makeRecorder();
        const result = await recorder.record(camera(source), { duration: 2 });
        assert.equal(result.format, 'mp4');
        assert.ok(result.size > 1000, `size ${result.size}`);
        assert.ok(fs.existsSync(result.file));
        assert.deepEqual(
            fs.readdirSync(out).filter(n => n.endsWith('.part')),
            [],
        );
        assert.match(path.basename(result.file), /^cam_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/);
    });

    it('records a copied mp4, a gif and a snapshot', async () => {
        const { recorder } = makeRecorder({ videoMode: 'copy' });
        const copy = await recorder.record(camera(source), { duration: 2 });
        const gif = await recorder.record(camera(source), { duration: 1, format: 'gif' });
        const jpg = await recorder.snapshot(camera(source), { width: 320 });
        assert.ok(copy.size > 1000);
        assert.equal(fs.readFileSync(gif.file).subarray(0, 3).toString(), 'GIF');
        const head = fs.readFileSync(jpg.file).subarray(0, 2);
        assert.equal(head[0], 0xff);
        assert.equal(head[1], 0xd8);
    });

    it('keeps the full clip length when the live stream is joined between two key frames', async () => {
        // a "camera" that sends a key frame every 4 s; the recorder connects 1.3 s after it started
        const live = path.join(dir, 'gop4.ts');
        execFileSync(ffmpegPath, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=320x240:rate=10',
            '-t',
            '30',
            '-c:v',
            'libx264',
            '-g',
            '40',
            '-keyint_min',
            '40',
            '-sc_threshold',
            '0',
            '-pix_fmt',
            'yuv420p',
            '-f',
            'mpegts',
            '-y',
            live,
        ]);
        const port = 20000 + Math.floor(Math.random() * 20000);
        const sender = spawn(
            String(ffmpegPath),
            [
                '-hide_banner',
                '-loglevel',
                'quiet',
                '-re',
                '-i',
                live,
                '-c',
                'copy',
                '-f',
                'mpegts',
                `udp://127.0.0.1:${port}?pkt_size=1316`,
            ],
            { stdio: 'ignore', windowsHide: true },
        );
        try {
            await new Promise(r => setTimeout(r, 1300));
            const { recorder } = makeRecorder();
            const clip = await recorder.record(camera(`udp://127.0.0.1:${port}`), { duration: 3 });
            assert.ok(clip.realDuration !== null && clip.realDuration >= 2.8, `file has ${clip.realDuration} s`);
            assert.equal(clip.realDuration, await mediaDuration(String(ffmpegPath), clip.file));
        } finally {
            sender.kill('SIGKILL');
        }
    });

    it('shares one run between two overlapping requests of the same kind', async () => {
        const { recorder, out } = makeRecorder();
        const [a, b] = await Promise.all([
            recorder.record(camera(source), { duration: 1 }),
            recorder.record(camera(source), { duration: 1 }),
        ]);
        assert.equal(a.file, b.file);
        assert.equal(fs.readdirSync(out).length, 1);
    });

    it('never shows the password in the error of an unreachable camera', async () => {
        const { recorder, out } = makeRecorder();
        const secret = 'S3cret!pw@x';
        await assert.rejects(
            recorder.record(camera('rtsp://127.0.0.1:9/stream', { username: 'admin', password: secret }), {
                duration: 1,
            }),
            err => {
                assert.ok(!err.message.includes(secret), err.message);
                assert.ok(!err.message.includes(encodeURIComponent(secret)), err.message);
                assert.match(err.message, /ffmpeg failed/);
                return true;
            },
        );
        assert.deepEqual(fs.readdirSync(out), []);
    });

    it('stops a process that does not finish in time', async () => {
        const runner = new FfmpegRunner({ ffmpegPath: String(ffmpegPath), maxParallel: 1, timers });
        const started = Date.now();
        await assert.rejects(
            runner.run(['-hide_banner', '-re', '-f', 'lavfi', '-i', 'testsrc', '-t', '30', '-f', 'null', '-'], {
                timeoutMs: 1500,
            }),
            /did not finish within/,
        );
        assert.ok(Date.now() - started < 10_000);
    });

    it('runs one process after the other with maxParallel 1 and rejects waiting jobs on stop', async () => {
        const runner = new FfmpegRunner({ ffmpegPath: String(ffmpegPath), maxParallel: 1, timers });
        const long = runner.run(
            ['-hide_banner', '-re', '-f', 'lavfi', '-i', 'testsrc', '-t', '20', '-f', 'null', '-'],
            {
                timeoutMs: 60_000,
            },
        );
        const waiting = runner.run(['-hide_banner', '-version'], { timeoutMs: 60_000 });
        assert.equal(runner.running, 1);
        assert.equal(runner.queue.length, 1);
        const checks = [assert.rejects(long, /adapter is stopping/), assert.rejects(waiting, /adapter is stopping/)];
        runner.stopAll();
        await Promise.all(checks);
        await assert.rejects(runner.run(['-version'], { timeoutMs: 1000 }), /adapter is stopping/);
    });
});

describe('storage', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-store-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds a free name for a second file in the same second', async () => {
        const date = new Date(2026, 9, 17, 8, 30, 5);
        const first = await uniqueFile(dir, 'cam', 'mp4', date);
        fs.writeFileSync(first, 'x');
        const second = await uniqueFile(dir, 'cam', 'mp4', date);
        assert.equal(path.basename(first), 'cam_2026-10-17_08-30-05.mp4');
        assert.equal(path.basename(second), 'cam_2026-10-17_08-30-05-2.mp4');
    });

    it('deletes only the oldest own files of one camera and kind', async () => {
        const names = [1, 2, 3, 4].map(m => `cam_${timeStamp(new Date(2026, 0, 1, 10, m, 0))}.mp4`);
        for (const n of names) {
            fs.writeFileSync(path.join(dir, n), 'x');
        }
        fs.writeFileSync(path.join(dir, 'cam_2026-01-01_09-00-00.jpg'), 'x');
        fs.writeFileSync(path.join(dir, 'other_2026-01-01_09-00-00.mp4'), 'x');
        fs.writeFileSync(path.join(dir, 'my-notes.mp4'), 'x');
        const deleted = await pruneFiles(dir, 'cam', 'mp4', 2, 0);
        assert.deepEqual(deleted.sort(), names.slice(0, 2).sort());
        assert.deepEqual(
            fs.readdirSync(dir).sort(),
            ['cam_2026-01-01_09-00-00.jpg', names[2], names[3], 'my-notes.mp4', 'other_2026-01-01_09-00-00.mp4'].sort(),
        );
    });

    it('deletes files older than the maximum age', async () => {
        const file = path.join(dir, 'cam_2026-01-01_10-00-00.mp4');
        fs.writeFileSync(file, 'x');
        const old = new Date(Date.now() - 10 * 86_400_000);
        fs.utimesSync(file, old, old);
        assert.deepEqual(await pruneFiles(dir, 'cam', 'mp4', 0, 7), ['cam_2026-01-01_10-00-00.mp4']);
    });

    it('removes leftover .part files of this adapter only', async () => {
        fs.writeFileSync(path.join(dir, 'cam_2026-01-01_10-00-00.mp4.part'), 'x');
        fs.writeFileSync(path.join(dir, 'foreign.part'), 'x');
        assert.equal(await removePartials(dir), 1);
        assert.deepEqual(fs.readdirSync(dir), ['foreign.part']);
    });
});
