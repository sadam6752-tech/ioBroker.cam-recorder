const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');
const { tests } = require('@iobroker/testing');

const ffmpegPath = require('ffmpeg-static');
const { startServer } = require('./helpers/sftp-server');

/**
 * Stops the adapter of the harness. js-controller 8 (dev builds from 2026-11-22) obeys sigKill only from the
 * controller of its own host, @iobroker/testing 6.3.2 sends it from system.host.testing: send it once more from the
 * host of the instance, otherwise stopAdapter never ends.
 *
 * @param {any} harness - Test harness, undefined when "before" failed early
 */
async function stopAdapter(harness) {
    if (!harness) {
        return;
    }
    const stopped = harness.stopAdapter();
    const host = (await harness.objects.getObjectAsync('system.adapter.cam-recorder.0'))?.common?.host;
    if (host && harness.isAdapterRunning()) {
        await harness.states.setStateAsync('system.adapter.cam-recorder.0.sigKill', {
            val: -1,
            ack: false,
            from: `system.host.${host}`,
        });
    }
    await stopped;
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Recording through sendTo with a local test video as camera', getHarness => {
            let harness;
            let dir;
            let source;
            let sftp;
            const disk = { files: new Map(), directories: new Set() };
            const oldDay = new Date(Date.now() - 2 * 86_400_000);

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
                // two frames of a timelapse from two days ago: the start builds the missed video
                const pad = n => String(n).padStart(2, '0');
                const day = `${oldDay.getFullYear()}-${pad(oldDay.getMonth() + 1)}-${pad(oldDay.getDate())}`;
                const frames = path.join(dir, 'media', 'timelapse', 'cafe_door');
                fs.mkdirSync(frames, { recursive: true });
                for (const time of ['10-00-00', '10-05-00']) {
                    execFileSync(String(ffmpegPath), [
                        ...['-hide_banner', '-loglevel', 'error', '-i', source, '-frames:v', '1', '-y'],
                        path.join(frames, `${day}_${time}.jpg`),
                    ]);
                }
                sftp = await startServer(disk);
                harness = getHarness();
                await harness.changeAdapterConfig('cam-recorder', {
                    native: {
                        cameras: [
                            { enabled: true, name: 'Café Door', url: source, username: '', password: 'Plain-Pw-123' },
                            { enabled: true, name: 'Garden', url: source, username: '', password: '', prebuffer: 2 },
                        ],
                        triggers: [
                            {
                                enabled: true,
                                stateId: '0_userdata.0.ring',
                                camera: 'Café Door',
                                action: 'snapshot',
                                cooldown: 60,
                                profiles: '',
                                condState: '0_userdata.0.away',
                                condOp: 'eq',
                                condValue: 'true',
                            },
                        ],
                        timelapses: [{ enabled: true, camera: 'Café Door', interval: 60, at: '23:55', fps: 10 }],
                        agentChecks: [
                            { enabled: true, criterion: 'a person', profiles: '', state: true, hold: 30 },
                            { enabled: true, criterion: 'a car', profiles: '', state: false },
                        ],
                        reportEnabled: true,
                        reportTime: '21:00',
                        remoteEnabled: true,
                        remoteHost: '127.0.0.1',
                        remotePort: sftp.port,
                        remoteUser: 'nas',
                        remotePassword: 'secret',
                        remoteDirectory: '/nas',
                        remoteHostKey: sftp.fingerprint,
                        prebufferEnabled: true,
                        prebufferDir: path.join(dir, 'prebuffer'),
                        outputDir: path.join(dir, 'media'),
                        recordDuration: 2,
                    },
                });
                for (const id of ['0_userdata.0.ring', '0_userdata.0.away']) {
                    await harness.objects.setObjectAsync(id, {
                        type: 'state',
                        common: { name: id, type: 'boolean', role: 'switch', read: true, write: true },
                        native: {},
                    });
                }
                await harness.states.setStateAsync('0_userdata.0.away', { val: false, ack: true });
                await harness.startAdapterAndWait(true);
                await harness.enableSendTo();
            });

            after(async function () {
                this.timeout(60_000);
                // the unload must end the ffmpeg of the pre-recording; on Windows a running
                // process would keep the source file locked and the removal would fail
                // when "before" failed early, there is nothing to stop
                await stopAdapter(harness);
                sftp?.close();
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

                const clip = await send('record', { camera: 'Café Door' });
                assert.ok(!clip.error, clip.error);
                assert.equal(clip.format, 'mp4');
                assert.ok(fs.statSync(clip.file).size > 1000);

                const shot = await send('snapshot', 'cafe_door');
                assert.ok(!shot.error, shot.error);
                assert.equal(shot.format, 'jpg');

                const lastVideo = await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.lastVideo');
                assert.equal(lastVideo?.val, clip.file);
                const status = await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.status');
                assert.equal(status?.val, 'idle');

                const unknown = await send('record', { camera: 'Cellar' });
                assert.match(unknown.error, /Unknown camera/);
            });

            it('creates the states of the AI check per camera, false at the start', async function () {
                this.timeout(30_000);
                for (const camera of ['cafe_door', 'garden']) {
                    const id = `cam-recorder.0.cameras.${camera}.ai.a_person`;
                    const obj = await harness.objects.getObjectAsync(id);
                    assert.equal(obj?.common?.type, 'boolean', id);
                    assert.equal(obj?.common?.name, 'a person');
                    assert.equal((await harness.states.getStateAsync(id))?.val, false);
                    // a criterion without State gets none
                    assert.equal(
                        await harness.objects.getObjectAsync(`cam-recorder.0.cameras.${camera}.ai.a_car`),
                        null,
                    );
                }
            });

            it('creates the states of the report and answers the command report', async function () {
                this.timeout(30_000);
                for (const id of ['send', 'text', 'lastTime']) {
                    const obj = await harness.objects.getObjectAsync(`cam-recorder.0.report.${id}`);
                    assert.ok(obj, id);
                }
                // nothing was checked (no pi-agent): an empty report, nothing sent
                const answer = await send('report', { send: false });
                assert.deepEqual(answer, { text: '' });
            });

            it('runs the schedule of a camera that a script writes, and confirms the values', async function () {
                this.timeout(120_000);
                const base = 'cam-recorder.0.cameras.garden.schedule';
                assert.equal((await harness.objects.getObjectAsync(`${base}.cron`))?.common?.write, true);
                assert.equal((await harness.states.getStateAsync(`${base}.enabled`))?.val, false);
                assert.equal((await harness.states.getStateAsync(`${base}.next`))?.val, 0);
                const before =
                    (await harness.states.getStateAsync('cam-recorder.0.cameras.garden.lastSnapshotTime'))?.val || 0;
                // a condition that holds: 0_userdata.0.away is false in this suite
                await harness.states.setStateAsync(`${base}.onlyIfState`, { val: '0_userdata.0.away', ack: false });
                await harness.states.setStateAsync(`${base}.onlyIfValue`, { val: 'false', ack: false });
                await harness.states.setStateAsync(`${base}.cron`, { val: '* * * * *', ack: false });
                await harness.states.setStateAsync(`${base}.enabled`, { val: true, ack: false });
                let next = 0;
                for (let i = 0; i < 20 && !next; i++) {
                    await new Promise(r => setTimeout(r, 250));
                    next = Number((await harness.states.getStateAsync(`${base}.next`))?.val) || 0;
                }
                assert.ok(next > Date.now() && next <= Date.now() + 61_000, `next ${next}`);
                assert.equal((await harness.states.getStateAsync(`${base}.enabled`))?.ack, true);
                // the run at the next full minute takes a snapshot
                let last = before;
                for (let i = 0; i < 90 && last === before; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    last = (await harness.states.getStateAsync('cam-recorder.0.cameras.garden.lastSnapshotTime'))?.val;
                }
                assert.notEqual(last, before, 'the schedule took no snapshot');
                await harness.states.setStateAsync(`${base}.enabled`, { val: false, ack: false });
            });

            it('answers the Device Manager through js-controller with one card per camera', async function () {
                this.timeout(30_000);
                const info = await send('dm:instanceInfo', {});
                assert.equal(info.apiVersion, 'v3');
                assert.equal(info.error, undefined);
                const loaded = await send('dm:loadDevices', {});
                assert.deepEqual(
                    loaded.add.map(d => [d.id, d.name]),
                    [
                        ['cafe_door', 'Café Door'],
                        ['garden', 'Garden'],
                    ],
                );
                assert.equal(loaded.total, 2);
                assert.deepEqual(
                    loaded.add[0].actions.map(a => a.id),
                    ['record', 'interval', 'snapshot', 'plan'],
                );
                // the own commands still work next to it
                const cameras = await send('listCameras', {});
                assert.equal(cameras.length, 2);
            });

            it('fires a trigger only while its condition holds, and a skipped event starts no cooldown', async function () {
                this.timeout(60_000);
                const shotTime = async () =>
                    (await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.lastSnapshotTime'))?.val || 0;
                const before = await shotTime();

                // nobody away: the ring is ignored
                await harness.states.setStateAsync('0_userdata.0.ring', { val: true, ack: true });
                await new Promise(r => setTimeout(r, 3000));
                assert.equal(await shotTime(), before, 'the trigger fired although the condition was not met');

                // away: the next ring fires at once, the skipped one did not start the 60 s cooldown
                await harness.states.setStateAsync('0_userdata.0.away', { val: true, ack: true });
                await harness.states.setStateAsync('0_userdata.0.ring', { val: true, ack: true });
                let after = before;
                for (let i = 0; i < 40 && after === before; i++) {
                    await new Promise(r => setTimeout(r, 250));
                    after = await shotTime();
                }
                assert.ok(after > before, 'the trigger did not fire with the condition met');
            });

            it('builds the missed timelapse at the start and copies the files to the SFTP server', async function () {
                this.timeout(60_000);
                const pad = n => String(n).padStart(2, '0');
                const day = `${oldDay.getFullYear()}-${pad(oldDay.getMonth() + 1)}-${pad(oldDay.getDate())}`;
                const remoteVideo = `/nas/cafe_door/cafe_door_timelapse_${day}.mp4`;
                // the copies run one after the other in the background: wait for all three kinds
                const copiedFiles = () => [...disk.files.keys()].filter(k => k.startsWith('/nas/cafe_door/'));
                const complete = () =>
                    disk.files.has(remoteVideo) &&
                    copiedFiles().some(k => /cafe_door_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/.test(k)) &&
                    copiedFiles().some(k => k.endsWith('.jpg'));
                let last;
                for (let i = 0; i < 160 && !(last && complete()); i++) {
                    await new Promise(r => setTimeout(r, 250));
                    last = (await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.lastTimelapse'))?.val;
                }
                assert.ok(String(last).endsWith(`cafe_door_timelapse_${day}.mp4`), String(last));
                assert.ok(disk.files.has(remoteVideo), [...disk.files.keys()].join(', '));
                // the clip and the snapshot of the earlier test were copied as well
                const copied = copiedFiles();
                const remoteError = (await harness.states.getStateAsync('cam-recorder.0.info.remoteError'))?.val;
                const why = `on the server: ${copied.join(', ')}; info.remoteError: ${remoteError || '-'}`;
                assert.ok(
                    copied.some(k => /cafe_door_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/.test(k)),
                    why,
                );
                assert.ok(
                    copied.some(k => k.endsWith('.jpg')),
                    why,
                );
                const error = await harness.states.getStateAsync('cam-recorder.0.info.remoteError');
                assert.equal(error?.val || '', '');
                const lastCopy = await harness.states.getStateAsync('cam-recorder.0.info.lastRemoteCopy');
                assert.ok(Number(lastCopy?.val) > 0);
                // the counter of the timelapse is back at 0 after the video, the next video is planned
                const frames = await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.timelapseFrames');
                assert.equal(frames?.val, 0);
                const next = await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.timelapseNextVideo');
                assert.ok(Number(next?.val) > Date.now(), String(next?.val));
            });

            it('runs the pre-recording and puts the seconds before the event into the clip', async function () {
                this.timeout(90_000);
                let status;
                for (let i = 0; i < 60; i++) {
                    status = (await harness.states.getStateAsync('cam-recorder.0.cameras.garden.prebuffer'))?.val;
                    if (status === 'running') {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
                assert.equal(status, 'running');
                // the camera without pre-recording keeps its buffer off
                const off = await harness.states.getStateAsync('cam-recorder.0.cameras.cafe_door.prebuffer');
                assert.equal(off?.val, 'off');
                await new Promise(r => setTimeout(r, 3000));

                const clip = await send('record', { camera: 'Garden', duration: 2 });
                assert.ok(!clip.error, clip.error);
                assert.ok(clip.pre > 0 && clip.pre <= 2, `pre ${clip.pre}`);
                assert.ok(clip.duration > 2, `duration ${clip.duration}`);
                assert.ok(fs.readdirSync(path.join(dir, 'prebuffer', 'garden')).some(n => n.endsWith('.mkv')));
            });
        });

        suite('Notification settings of 0.4.x become profiles at the first start', getHarness => {
            let harness;
            const id = 'system.adapter.cam-recorder.0';

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                // the whole instance object, so no row of another suite is merged into these tables
                const obj = await harness.objects.getObjectAsync(id);
                obj.native = {
                    ...obj.native,
                    cameras: [],
                    prebufferEnabled: false,
                    remoteEnabled: false,
                    profiles: [],
                    profilesMigrated: false,
                    telegramInstance: 'telegram.0',
                    telegramUser: 'Alex',
                    telegramCaption: '{camera} rings',
                    notifyTargets: [
                        { enabled: true, name: 'Father', instance: 'max.0', recipient: '222', template: '' },
                        { enabled: true, name: 'Papa', instance: 'max.0', recipient: '222', template: '' },
                    ],
                    triggers: [
                        { enabled: true, stateId: 'a.0.all', camera: 'Door', telegram: true, recipients: '' },
                        { enabled: true, stateId: 'a.0.papa', camera: 'Door', telegram: true, recipients: 'Papa' },
                        { enabled: true, stateId: 'a.0.off', camera: 'Door', telegram: false, recipients: '' },
                    ],
                    timelapses: [{ enabled: true, camera: 'Door', notify: true, recipients: 'Telegram' }],
                };
                await harness.objects.setObjectAsync(id, obj);
                // not waiting for info.connection: after the write the adapter waits for the restart
                // by the js-controller, which the test harness does not do
                await harness.startAdapterAndWait();
            });

            after(async function () {
                this.timeout(30_000);
                await stopAdapter(harness);
            });

            it('writes the profiles once into the instance object and keeps the old keys', async function () {
                this.timeout(30_000);
                let native;
                for (let i = 0; i < 40; i++) {
                    native = (await harness.objects.getObjectAsync(id))?.native;
                    if (native?.profilesMigrated === true) {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
                assert.equal(native?.profilesMigrated, true);
                assert.deepEqual(
                    native.profiles.map(p => [p.name, p.instance, p.recipient, p.attach, p.text]),
                    [
                        ['Telegram', 'telegram.0', 'Alex', 'all', '{camera} rings'],
                        ['Father', 'max.0', '222', 'all', '{camera} rings'],
                    ],
                );
                assert.deepEqual(
                    native.triggers.map(t => t.profiles),
                    ['Telegram, Father', 'Father', ''],
                );
                assert.deepEqual(
                    native.timelapses.map(t => t.profiles),
                    ['Telegram'],
                );
                assert.equal(native.telegramInstance, 'telegram.0');
                assert.equal(native.notifyTargets.length, 2);

                // nothing is written a second time
                const ts = (await harness.objects.getObjectAsync(id))?.ts;
                await new Promise(r => setTimeout(r, 3000));
                assert.equal((await harness.objects.getObjectAsync(id))?.ts, ts);
            });
        });
    },
});
