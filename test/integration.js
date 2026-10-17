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
                    'testsrc=size=640x360:rate=15',
                    '-t',
                    '5',
                    '-c:v',
                    'libx264',
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
                        ],
                        outputDir: path.join(dir, 'media'),
                        recordDuration: 2,
                    },
                });
                await harness.startAdapterAndWait(true);
                await harness.enableSendTo();
            });

            after(() => {
                fs.rmSync(dir, { recursive: true, force: true });
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

                const unknown = await send('record', { camera: 'Garten' });
                assert.match(unknown.error, /Unknown camera/);
            });
        });
    },
});
