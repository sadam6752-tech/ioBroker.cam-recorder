'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
    parseSegments,
    selectSegments,
    expiredSegments,
    concatList,
    restartDelay,
} = require('../../lib/prebuffer-plan');
const { Prebuffer, isStalled, STALL_MS } = require('../../lib/prebuffer');
const { FfmpegRunner, resolveFfmpegPath } = require('../../lib/ffmpeg-runner');
const { Recorder } = require('../../lib/recorder');
const { normalizeSettings } = require('../../lib/config');

const ffmpegPath = String(resolveFfmpegPath(''));
const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) };

/** @param {number} sec - Seconds after 10:00:00 */
const at = sec => new Date(2026, 9, 17, 10, 0, sec).getTime();
/** @param {number} sec - Seconds after 10:00:00 */
const name = sec => {
    const d = new Date(at(sec));
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.ts`;
};

describe('pre-recording plan', () => {
    const segs = parseSegments([name(6), name(0), 'x.ts', name(2), name(4), 'list.txt']);

    it('reads segment names as local times, oldest first', () => {
        assert.deepEqual(
            segs.map(s => s.start),
            [at(0), at(2), at(4), at(6)],
        );
    });

    it('picks the complete segments of a window and the offset into the first', () => {
        const picked = selectSegments(segs, at(1), at(3.5));
        assert.deepEqual(
            picked.segments.map(s => s.start),
            [at(0), at(2)],
        );
        assert.equal(picked.offset, 1);
        assert.equal(picked.complete, true);
    });

    it('reports a window that is not yet on disk as incomplete', () => {
        const picked = selectSegments(segs, at(3), at(7));
        assert.equal(picked.complete, false);
        // the newest segment is still being written and is never used
        assert.deepEqual(
            picked.segments.map(s => s.start),
            [at(2), at(4)],
        );
    });

    it('deletes only segments that ended before the kept time', () => {
        assert.deepEqual(
            expiredSegments(segs, at(4)).map(s => s.start),
            [at(0), at(2)],
        );
        assert.deepEqual(expiredSegments(segs, at(100)).length, 3);
    });

    it('writes a concat list with forward slashes and escaped quotes', () => {
        assert.equal(concatList(['C:\\tmp\\a.ts', "/x/it's.ts"]), "file 'C:/tmp/a.ts'\nfile '/x/it'\\''s.ts'\n");
    });

    it('counts a buffer as stalled only after the limit without growth', () => {
        assert.equal(isStalled(1000, 1000 + STALL_MS), false);
        assert.equal(isStalled(1000, 1001 + STALL_MS), true);
    });

    it('waits longer after every failed start', () => {
        assert.deepEqual([1, 2, 3, 4, 5, 9].map(restartDelay), [5000, 10000, 30000, 60000, 300000, 300000]);
    });
});

/**
 * @param {string} file - Media file
 * @returns {number} Duration in seconds read from ffmpeg's banner
 */
function mediaSeconds(file) {
    const out = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
    assert.ok(m, out);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * @param {() => boolean} check - Condition
 * @param {number} ms - Limit
 */
async function waitFor(check, ms) {
    const end = Date.now() + ms;
    while (!check()) {
        assert.ok(Date.now() < end, 'condition not reached in time');
        await new Promise(r => setTimeout(r, 200));
    }
}

describe('pre-recording with a live test source (real ffmpeg)', function () {
    this.timeout(120_000);
    let dir;
    let source;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-pre-'));
        source = path.join(dir, 'live.ts');
        // a key frame every second, so segments can be cut every 2 s
        execFileSync(ffmpegPath, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=320x240:rate=10',
            '-t',
            '20',
            '-c:v',
            'libx264',
            '-g',
            '10',
            '-pix_fmt',
            'yuv420p',
            '-y',
            source,
        ]);
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** @returns {import('../../lib/types').Camera} Camera reading the test file in real time */
    const camera = () => ({
        id: 'cam',
        name: 'Cam',
        url: source,
        username: '',
        password: '',
        transport: 'tcp',
        keyframesOnly: false,
        prebuffer: 3,
    });

    it('keeps segments, cuts a clip with the seconds before the event and stops cleanly', async () => {
        const settings = normalizeSettings({ rtspTimeout: 2 });
        const statuses = [];
        const buffer = new Prebuffer({
            camera: camera(),
            settings,
            seconds: 3,
            dir: path.join(dir, 'buffer'),
            ffmpegPath,
            timers,
            onStatus: s => statuses.push(s),
        });
        await buffer.start();
        try {
            await waitFor(() => buffer.isRunning(), 20_000);
            // let the buffer fill the pre-recording window
            await new Promise(r => setTimeout(r, 4000));
            const out = fs.mkdtempSync(path.join(dir, 'out-'));
            const recorder = new Recorder({
                runner: new FfmpegRunner({ ffmpegPath, maxParallel: 2, timers }),
                outputDir: out,
                settings,
                withPassword: c => c,
                getPrebuffer: () => buffer,
            });
            const started = Date.now();
            const clip = await recorder.record(camera(), { duration: 2 });
            const waited = Date.now() - started;
            assert.equal(clip.pre, 3);
            assert.equal(clip.duration, 5);
            assert.ok(waited >= 2000, `returned after ${waited} ms, before the time after the event was recorded`);
            const seconds = mediaSeconds(clip.file);
            assert.ok(seconds > 4 && seconds < 6.5, `clip has ${seconds} s`);
            // no list file left in the buffer folder
            assert.deepEqual(
                fs.readdirSync(buffer.dir).filter(n => !n.endsWith('.ts')),
                [],
            );
        } finally {
            await buffer.stop();
        }
        assert.deepEqual(statuses.slice(0, 2), ['starting', 'running']);
        assert.equal(statuses[statuses.length - 1], 'off');
        assert.equal(fs.existsSync(path.join(dir, 'buffer')), false);
    });

    it('records live when the buffer is not running', async () => {
        const settings = normalizeSettings({ rtspTimeout: 2 });
        const buffer = new Prebuffer({
            camera: camera(),
            settings,
            seconds: 3,
            dir: path.join(dir, 'idle'),
            ffmpegPath,
            timers,
        });
        const warnings = [];
        const recorder = new Recorder({
            runner: new FfmpegRunner({ ffmpegPath, maxParallel: 2, timers }),
            outputDir: fs.mkdtempSync(path.join(dir, 'out-')),
            settings,
            withPassword: c => c,
            getPrebuffer: () => buffer,
            onWarning: m => warnings.push(m),
        });
        const clip = await recorder.record(camera(), { duration: 1 });
        assert.equal(clip.pre, 0);
        assert.equal(clip.duration, 1);
        assert.deepEqual(warnings, [
            'Camera "Cam": the pre-recording is not ready (off), the clip starts at the event',
        ]);
    });

    it('records live when the segments cannot be joined', async () => {
        const settings = normalizeSettings({ rtspTimeout: 2 });
        const broken = path.join(dir, 'broken');
        fs.mkdirSync(broken, { recursive: true });
        fs.writeFileSync(path.join(broken, 'garbage.ts'), 'not a video');
        const warnings = [];
        let released = 0;
        const fake = /** @type {any} */ ({
            seconds: 3,
            dir: broken,
            isRunning: () => true,
            collect: async () => ({
                files: [path.join(broken, 'garbage.ts')],
                first: Date.now() - 3000,
                offset: 0,
                complete: true,
                release: () => released++,
            }),
        });
        const recorder = new Recorder({
            runner: new FfmpegRunner({ ffmpegPath, maxParallel: 2, timers }),
            outputDir: fs.mkdtempSync(path.join(dir, 'out-')),
            settings,
            withPassword: c => c,
            getPrebuffer: () => fake,
            onWarning: m => warnings.push(m),
        });
        const clip = await recorder.record(camera(), { duration: 1 });
        assert.equal(clip.pre, 0);
        assert.ok(fs.statSync(clip.file).size > 0);
        assert.equal(released, 1);
        assert.match(warnings[0], /could not be joined .* recording live instead/);
        assert.deepEqual(fs.readdirSync(broken), ['garbage.ts']);
    });

    it('does not restart a buffer whose camera sends a key frame only every 25 s', async function () {
        this.timeout(90_000);
        const longGop = path.join(dir, 'long-gop.ts');
        execFileSync(ffmpegPath, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=160x120:rate=10',
            '-t',
            '60',
            '-c:v',
            'libx264',
            '-g',
            '250',
            '-keyint_min',
            '250',
            '-sc_threshold',
            '0',
            '-pix_fmt',
            'yuv420p',
            '-y',
            longGop,
        ]);
        const warnings = [];
        const buffer = new Prebuffer({
            camera: { ...camera(), url: longGop },
            settings: normalizeSettings({ rtspTimeout: 2 }),
            seconds: 3,
            dir: path.join(dir, 'long-gop'),
            ffmpegPath,
            timers,
            onWarning: m => warnings.push(m),
        });
        await buffer.start();
        try {
            // longer than the stall limit, while the first segment is still being written
            await new Promise(r => setTimeout(r, STALL_MS + 5000));
            assert.deepEqual(warnings, []);
            assert.ok(buffer.child, 'the process was stopped');
        } finally {
            await buffer.stop();
        }
    });

    it('restarts a failing buffer and never shows the password', async () => {
        const settings = normalizeSettings({ rtspTimeout: 2 });
        const warnings = [];
        const statuses = [];
        const secret = 'Pre-S3cret!';
        const buffer = new Prebuffer({
            camera: { ...camera(), url: 'rtsp://127.0.0.1:9/x', username: 'admin', password: secret },
            settings,
            seconds: 3,
            dir: path.join(dir, 'failing'),
            ffmpegPath,
            timers,
            onStatus: s => statuses.push(s),
            onWarning: m => warnings.push(m),
        });
        await buffer.start();
        try {
            await waitFor(() => warnings.length > 0, 20_000);
        } finally {
            await buffer.stop();
        }
        assert.match(warnings[0], /Pre-recording of camera "Cam" stopped .*Next start in 5 s/);
        assert.ok(!warnings.join(' ').includes(secret), warnings.join(' '));
        assert.ok(statuses.includes('restarting'));
    });
});
