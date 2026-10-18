'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Timelapse, parseTime, msUntil, framesOf, frameList, CATCH_UP_MS } = require('../../lib/timelapse');
const { FfmpegRunner, resolveFfmpegPath, mediaDuration } = require('../../lib/ffmpeg-runner');
const { Recorder } = require('../../lib/recorder');
const { normalizeSettings, normalizeCameras, normalizeTimelapses } = require('../../lib/config');
const { timeStamp } = require('../../lib/storage');

const ffmpegPath = String(resolveFfmpegPath(''));
const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) };

describe('timelapse: rules', () => {
    it('reads the build time and computes the wait until it', () => {
        assert.deepEqual(parseTime('23:55'), { hour: 23, minute: 55 });
        assert.deepEqual(parseTime('7:05'), { hour: 7, minute: 5 });
        assert.equal(parseTime('24:00'), null);
        assert.equal(parseTime('noon'), null);
        const now = new Date(2026, 9, 18, 10, 0, 0);
        assert.equal(msUntil({ hour: 10, minute: 30 }, now), 30 * 60_000);
        assert.equal(msUntil({ hour: 10, minute: 0 }, now), 24 * 3600_000, 'the time just passed: tomorrow');
    });

    it('sorts its frames and ignores other files', () => {
        assert.deepEqual(framesOf(['2026-10-18_10-05-00.jpg', 'frames.txt', '2026-10-18_10-00-00.jpg', 'x.jpg']), [
            '2026-10-18_10-00-00.jpg',
            '2026-10-18_10-05-00.jpg',
        ]);
    });

    it('lists every frame for 1/fps and repeats the last one', () => {
        assert.equal(
            frameList(['/a/1.jpg', '/a/2.jpg'], 10),
            "file '/a/1.jpg'\nduration 0.1000\nfile '/a/2.jpg'\nduration 0.1000\nfile '/a/2.jpg'\n",
        );
    });

    it('reads the timelapse table', () => {
        const { cameras } = normalizeCameras([{ name: 'Door', url: 'rtsp://h/1' }]);
        const { jobs, problems } = normalizeTimelapses(
            [
                { camera: 'Door', interval: 0, at: '6:30', fps: 500, notify: true },
                { camera: 'Door' },
                { camera: 'Garden' },
            ],
            cameras,
        );
        assert.equal(jobs.length, 1);
        assert.deepEqual(
            { ...jobs[0], camera: jobs[0].camera.id },
            {
                camera: 'door',
                interval: 1,
                at: { hour: 6, minute: 30 },
                fps: 60,
                notify: true,
            },
        );
        assert.equal(problems.length, 2);
    });
});

describe('timelapse with real ffmpeg', function () {
    this.timeout(120_000);
    let dir;
    let source;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-tl-'));
        source = path.join(dir, 'cam.mp4');
        execFileSync(ffmpegPath, [
            ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '5'],
            ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source],
        ]);
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @param {string} out - Media folder
     * @param {(r: any) => void} onVideo - Video callback
     * @returns {Timelapse} Timelapse of a camera reading the test file
     */
    function makeTimelapse(out, onVideo) {
        const settings = normalizeSettings({ videoWidth: 160, maxAgeDays: 7 });
        const camera = normalizeCameras([{ name: 'Door', url: source }]).cameras[0];
        const recorder = new Recorder({
            runner: new FfmpegRunner({ ffmpegPath, maxParallel: 2, timers }),
            outputDir: out,
            settings,
            withPassword: c => c,
        });
        return new Timelapse({
            camera,
            job: { camera, interval: 60, at: { hour: 23, minute: 55 }, fps: 10, notify: false },
            settings,
            outputDir: out,
            recorder,
            timers,
            onVideo,
            onWarning: () => undefined,
        });
    }

    it('takes frames, builds a video from them, deletes them and names a second video of the day -2', async () => {
        const out = fs.mkdtempSync(path.join(dir, 'out-'));
        const videos = [];
        const timelapse = makeTimelapse(out, r => videos.push(r));
        assert.equal(await timelapse.build(), null, 'no video from fewer than two frames');
        // frames from three different seconds
        for (let i = 0; i < 3; i++) {
            const file = path.join(timelapse.dir, `2026-10-18_10-0${i}-00.jpg`);
            fs.mkdirSync(timelapse.dir, { recursive: true });
            await timelapse.recorder.grabFrame(timelapse.camera, file, 160);
        }
        const first = await timelapse.build();
        assert.ok(first);
        assert.equal(path.basename(first.file), 'door_timelapse_2026-10-18.mp4');
        assert.equal(first.duration, 0.3);
        const seconds = await mediaDuration(ffmpegPath, first.file);
        assert.ok(seconds !== null && seconds >= 0.2 && seconds <= 0.5, `video has ${seconds} s`);
        assert.deepEqual(await timelapse.frames(), []);
        assert.deepEqual(
            videos.map(v => v.file),
            [first.file],
        );

        for (let i = 0; i < 2; i++) {
            await timelapse.recorder.grabFrame(
                timelapse.camera,
                path.join(timelapse.dir, `2026-10-18_11-0${i}-00.jpg`),
                0,
            );
        }
        const second = await timelapse.build();
        assert.equal(path.basename(second?.file || ''), 'door_timelapse_2026-10-18-2.mp4');
    });

    it('takes a frame with takeFrame and builds a missed video at the start', async () => {
        const out = fs.mkdtempSync(path.join(dir, 'out-'));
        const videos = [];
        const timelapse = makeTimelapse(out, r => videos.push(r));
        const frame = await timelapse.takeFrame();
        assert.ok(frame && fs.statSync(frame).size > 0);
        // a frame from two days ago: the start has to build the missed video at once
        const old = new Date(Date.now() - CATCH_UP_MS - 3600_000);
        fs.copyFileSync(frame, path.join(timelapse.dir, `${timeStamp(old)}.jpg`));
        await timelapse.start();
        try {
            for (let i = 0; i < 100 && !videos.length; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
        } finally {
            timelapse.stop();
        }
        assert.equal(videos.length, 1);
        assert.match(
            path.basename(videos[0].file),
            new RegExp(`^door_timelapse_${timeStamp(old).slice(0, 10)}\\.mp4$`),
        );
    });
});
