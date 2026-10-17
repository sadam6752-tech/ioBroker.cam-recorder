const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');
const { tests } = require('@iobroker/testing');

const ffmpegPath = require('ffmpeg-static');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Recording through sendTo with a local test video as camera', getHarness => {
            let harness;
            let dir;
            let source;

            before(async function () {
                this.timeout(120_000);
                dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-recorder-it-'));
                source = path.join(dir, 'door.mp4');
                execFileSync(String(ffmpegPath), [
                    '-hide_banner',
                    '-loglevel',
                    'error',
                    '-f',
                    'lavfi',
                    '-i',
                    'testsrc=size=320x240:rate=10',
                    // longer than the test runs: the pre-recording reads it in real time, and a
                    // looped file gives segments with jumping timestamps
                    '-t',
                    '60',
                    '-c:v',
                    'libx264',
                    // a key frame every second like a camera
                    '-g',
                    '10',
                    '-pix_fmt',
                    'yuv420p',
                    '-y',
                    source,
                ]);
                harness = getHarness();
                await harness.changeAdapterConfig('cam-recorder', {
                    native: {
                        cameras: [
                            { enabled: true, name: 'Haustür', url: source, username: '', password: 'Plain-Pw-123' },
                            { enabled: true, name: 'Garten', url: source, username: '', password: '', prebuffer: 2 },
                        ],
                        prebufferEnabled: true,
                        prebufferDir: path.join(dir, 'prebuffer'),
                        outputDir: path.join(dir, 'media'),
                        recordDuration: 2,
                    },
                });
                await harness.startAdapterAndWait(true);
                await harness.enableSendTo();
            });

            after(async function () {
                this.timeout(60_000);
                // the unload must end the ffmpeg of the pre-recording; on Windows a running
                // process would keep the source file locked and the removal would fail
                await harness.stopAdapter();
                fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
            });

            /**
             * @param {string} command - Command
             * @param {any} message - Message
             * @returns {Promise<any>} Answer of the adapter
             */
            const send = (command, message) =>
                new Promise(resolve => harness.sendTo('cam-recorder.0', command, message, resolve));

            it('stores the camera password encrypted', async function () {
                this.timeout(30_000);
                // the adapter writes the instance object once and is restarted by the controller
                let stored;
                for (let i = 0; i < 40; i++) {
                    const obj = await harness.objects.getObjectAsync('system.adapter.cam-recorder.0');
                    stored = obj?.native?.cameras?.[0]?.password;
                    if (typeof stored === 'string' && stored.startsWith('enc:')) {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
                assert.ok(typeof stored === 'string' && stored.startsWith('enc:'), String(stored));
                assert.ok(!stored.includes('Plain-Pw-123'));
            });

            it('records a clip and a snapshot and publishes them in the states', async function () {
                this.timeout(90_000);
                // wait for the instance (it may just have restarted after the password migration)
                let ready = false;
                for (let i = 0; i < 60 && !ready; i++) {
                    ready = (await harness.states.getStateAsync('cam-recorder.0.info.connection'))?.val === true;
                    if (!ready) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
                assert.ok(ready, 'info.connection never became true');

                const clip = await send('record', { camera: 'Haustür' });
                assert.ok(!clip.error, clip.error);
                assert.equal(clip.format, 'mp4');
                assert.ok(fs.statSync(clip.file).size > 1000);

                const shot = await send('snapshot', 'haustuer');
                assert.ok(!shot.error, shot.error);
                assert.equal(shot.format, 'jpg');

                const lastVideo = await harness.states.getStateAsync('cam-recorder.0.cameras.haustuer.lastVideo');
                assert.equal(lastVideo?.val, clip.file);
                const status = await harness.states.getStateAsync('cam-recorder.0.cameras.haustuer.status');
                assert.equal(status?.val, 'idle');

                const unknown = await send('record', { camera: 'Keller' });
                assert.match(unknown.error, /Unknown camera/);
            });

            it('runs the pre-recording and puts the seconds before the event into the clip', async function () {
                this.timeout(90_000);
                let status;
                for (let i = 0; i < 60; i++) {
                    status = (await harness.states.getStateAsync('cam-recorder.0.cameras.garten.prebuffer'))?.val;
                    if (status === 'running') {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
                assert.equal(status, 'running');
                // the camera without pre-recording keeps its buffer off
                const off = await harness.states.getStateAsync('cam-recorder.0.cameras.haustuer.prebuffer');
                assert.equal(off?.val, 'off');
                await new Promise(r => setTimeout(r, 3000));

                const clip = await send('record', { camera: 'Garten', duration: 2 });
                assert.ok(!clip.error, clip.error);
                assert.ok(clip.pre > 0 && clip.pre <= 2, `pre ${clip.pre}`);
                assert.ok(clip.duration > 2, `duration ${clip.duration}`);
                assert.ok(fs.readdirSync(path.join(dir, 'prebuffer', 'garten')).some(n => n.endsWith('.ts')));
            });
        });
    },
});
