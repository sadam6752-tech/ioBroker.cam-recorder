'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CameraDeviceManagement } = require('../../lib/device-manager');
const { DM_TEXTS } = require('../../lib/dm-texts');
const { normalizeCameras } = require('../../lib/config');

const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
const NS = 'cam-recorder.0';
const SNAP_TIME = new Date(2026, 10, 11, 9, 5, 7).getTime();

/**
 * A stand-in for the adapter with two cameras: "Door" with pre-recording and a snapshot in the
 * file storage, "Garden" without anything recorded yet.
 *
 * @param {object} [options] - Changes
 * @param {boolean} [options.fail] - `_take` fails
 * @param {string} [options.storageId] - File storage, empty = no copies
 * @returns {any} The stand-in and what it saw
 */
function fakeAdapter({ fail = false, storageId = `${NS}.storage` } = {}) {
    const { cameras } = normalizeCameras([
        { name: 'Door', url: 'rtsp://h/1', prebuffer: 3 },
        { name: 'Garden', url: 'rtsp://h/2' },
    ]);
    /** @type {Record<string, any>} */
    const states = {
        'cameras.door.schedule.interval': 30,
        'cameras.door.schedule.profiles': 'Alex, Gone',
        'cameras.door.lastVideoTime': new Date(2026, 10, 10, 18, 30, 0).getTime(),
        'cameras.door.lastSnapshotTime': SNAP_TIME,
    };
    const taken = [];
    /** @type {any[]} */
    const sent = [];
    /** @type {((obj: any) => void)[]} */
    const listeners = [];
    return {
        namespace: NS,
        cameras,
        settings: { prebufferEnabled: true, profiles: [{ name: 'Alex' }, { name: 'Family' }] },
        states,
        /** @type {any[]} */
        schedules: [],
        async _setSchedule(/** @type {any} */ camera, /** @type {Record<string, unknown>} */ values) {
            this.schedules.push([camera.id, values]);
            for (const [key, value] of Object.entries(values)) {
                states[`cameras.${camera.id}.schedule.${key}`] = value;
            }
            states[`cameras.${camera.id}.schedule.next`] = values.cron === 'bad' ? 0 : SNAP_TIME + 3_600_000;
            return values.cron === 'bad' ? ['cron "bad": a cron pattern needs five fields'] : [];
        },
        storageId,
        dateFormat: 'DD.MM.YYYY',
        ready: Promise.resolve(),
        log: { debug() {}, info() {}, warn() {}, error() {} },
        taken,
        sent,
        listeners,
        on(/** @type {string} */ event, /** @type {any} */ fn) {
            if (event === 'message') {
                listeners.push(fn);
            }
        },
        sendTo(/** @type {any[]} */ ...args) {
            sent.push(args);
        },
        async getStateAsync(/** @type {string} */ id) {
            return id in states ? { val: states[id], ack: true, ts: 0, lc: 0, from: '' } : null;
        },
        async fileExistsAsync(/** @type {string} */ id, /** @type {string} */ file) {
            return id === `${NS}.storage` && file === 'door.jpg';
        },
        async _take(/** @type {any} */ camera, /** @type {string} */ kind, /** @type {object} */ request, notify) {
            taken.push({ camera: camera.id, kind, request, notify });
            if (fail) {
                throw new Error('camera "Door" is not reachable');
            }
            const file = `/media/${camera.id}_2026-11-11_09-05-07.${kind === 'record' ? 'mp4' : 'jpg'}`;
            states[`cameras.${camera.id}.last${kind === 'record' ? 'Video' : 'Snapshot'}Time`] = SNAP_TIME + 1000;
            return { file, format: kind === 'record' ? 'mp4' : 'jpg', camera: camera.name };
        },
    };
}

/**
 * @param {any} adapter - Stand-in
 * @returns {Promise<any[]>} The cards that loadDevices adds
 */
async function load(adapter) {
    const dm = new CameraDeviceManagement(adapter);
    /** @type {any[]} */
    const devices = [];
    let total = -1;
    await dm.loadDevices({
        addDevice: device => devices.push(device),
        setTotalDevices: count => (total = count),
    });
    assert.equal(total, devices.length);
    return devices;
}

/**
 * @param {any} [form] - Answer of a form: data, a function of the shown data, or undefined = cancelled
 * @returns {any} A stand-in for the dialogs of the Device Manager
 */
function fakeContext(form = undefined) {
    const log = [];
    return {
        log,
        async showForm(/** @type {any} */ schema, /** @type {any} */ options) {
            log.push(['form', schema, options]);
            return typeof form === 'function' ? form(options.data) : form;
        },
        async showMessage(/** @type {any} */ text) {
            log.push(['message', text]);
        },
        async openProgress(/** @type {any} */ title, /** @type {any} */ options) {
            log.push(['progress', title, options]);
            return {
                async update() {},
                async close() {
                    log.push(['close']);
                },
            };
        },
    };
}

/**
 * @param {any} card - Card
 * @param {string} id - Action id
 * @returns {(...args: any[]) => Promise<any>} Handler of the action
 */
const action = (card, id) => card.actions.find(a => a.id === id).handler;

describe('Device Manager', () => {
    it('shows one card per configured camera with status, last times and the last snapshot', async () => {
        const [door, garden] = await load(fakeAdapter());
        assert.equal(door.id, 'door');
        assert.equal(door.name, 'Door');
        assert.equal(door.identifier, 'cameras.door');
        // online follows the check of the camera on the network, with and without pre-recording
        for (const card of [door, garden]) {
            assert.deepEqual(card.status.connection, {
                stateId: `${NS}.cameras.${card.id}.reachable`,
                mapping: { true: 'connected', false: 'disconnected' },
            });
        }
        assert.deepEqual(door.status.warning, { stateId: `${NS}.cameras.door.lastError` });
        // "recording now" follows the status state live
        const [activity] = door.indicators;
        assert.equal(activity.value.stateId, `${NS}.cameras.door.status`);
        assert.equal(activity.value.mapping.idle, '');
        assert.equal(activity.value.mapping.recording, 'recording');
        assert.equal(activity.levels[0].text, DM_TEXTS.recording);

        const lines = Object.values(door.customInfo.schema.items).map(item => item.text);
        assert.equal(lines[0].de, 'Letzter Clip: 10.11.2026 18:30:00');
        assert.equal(lines[1].en, 'Last snapshot: 11.11.2026 09:05:07');
        assert.equal(lines[2].de, 'Voraufnahme 3 s');
        const gardenLines = Object.values(garden.customInfo.schema.items).map(item => item.text);
        assert.equal(gardenLines.length, 2);
        assert.equal(gardenLines[0].de, 'Letzter Clip: noch keiner');
        assert.equal(gardenLines[1].ru, 'Последний снимок: пока нет');

        assert.equal(door.icon, `files/${NS}.storage/door.jpg?t=${SNAP_TIME}`);
        assert.equal(garden.icon, undefined);
        assert.deepEqual(
            door.actions.map(a => [a.id, a.title.de]),
            [
                ['record', 'Videoaufnahme'],
                ['interval', 'Intervall'],
                ['snapshot', 'Schnappschuss'],
                ['plan', 'Zeitplan'],
            ],
        );
    });

    it('edits the interval in a form with the current values and shows the next run', async () => {
        const adapter = fakeAdapter();
        const dm = new CameraDeviceManagement(adapter);
        const card = await dm.getDeviceInfo('door');
        adapter.settings.agentInstance = 'pi-agent.0';
        const context = fakeContext(data => ({
            ...data,
            enabled: true,
            interval: 15,
            from: '22:00',
            to: '06:00',
            aiOnly: true,
            onlyIfState: ' 0_userdata.0.away ',
            onlyIfOp: 'eq',
            onlyIfValue: 'true',
        }));
        const answer = await action(card, 'interval')('door', context);
        const [, schema, options] = context.log[0];
        assert.deepEqual(Object.keys(schema.items), [
            'enabled',
            'interval',
            'from',
            'to',
            'action',
            'profiles',
            'aiOnly',
            'onlyIfState',
            'onlyIfOp',
            'onlyIfValue',
            '_shared',
        ]);
        assert.equal(schema.items.aiOnly.disabled, 'false');
        assert.equal(options.data.onlyIfOp, 'eq');
        assert.equal(options.data.interval, 30);
        assert.deepEqual(options.data.profiles, ['Alex', 'Gone']);
        // a profile that is gone stays choosable, so saving does not drop it silently
        assert.deepEqual(
            schema.items.profiles.options.map(o => o.value),
            ['Alex', 'Family', 'Gone'],
        );
        assert.deepEqual(adapter.schedules[0], [
            'door',
            {
                enabled: true,
                aiOnly: true,
                onlyIfState: '0_userdata.0.away',
                onlyIfOp: 'eq',
                onlyIfValue: 'true',
                action: 'snapshot',
                profiles: 'Alex, Gone',
                interval: 15,
                from: '22:00',
                to: '06:00',
            },
        ]);
        assert.match(context.log[1][1].de, /^Zeitplan gespeichert: 11\.11\.2026 10:05:07$/);
        const lines = Object.values(answer.update.customInfo.schema.items).map(item => item.text);
        assert.equal(lines[lines.length - 1].de, 'Zeitplan: nächste 11.11.2026 10:05:07');
    });

    it('edits the plan with the cron dialog and reports a wrong pattern; cancel changes nothing', async () => {
        const adapter = fakeAdapter();
        const dm = new CameraDeviceManagement(adapter);
        const card = await dm.getDeviceInfo('garden');
        // without pi-agent the switch is greyed out and a value from a script is not taken over
        const context = fakeContext(data => ({
            ...data,
            cron: 'bad',
            action: 'both',
            profiles: ['Family'],
            aiOnly: true,
        }));
        await action(card, 'plan')('garden', context);
        assert.equal(context.log[0][1].items.cron.type, 'cron');
        assert.equal(context.log[0][1].items.aiOnly.disabled, 'true');
        assert.deepEqual(context.log[0][1].items.aiOnly.help, DM_TEXTS.aiOnlyNoAgent);
        assert.deepEqual(adapter.schedules[0], [
            'garden',
            {
                enabled: false,
                aiOnly: false,
                onlyIfState: '',
                onlyIfOp: 'eq',
                onlyIfValue: '',
                action: 'both',
                profiles: 'Family',
                cron: 'bad',
            },
        ]);
        assert.match(context.log[1][1].en, /^Saved, but: cron "bad"/);

        const cancelled = fakeContext(undefined);
        assert.deepEqual(await action(card, 'plan')('garden', cancelled), { refresh: 'none' });
        assert.equal(adapter.schedules.length, 1);
    });

    it('shows no picture when the copy into the file storage is off', async () => {
        const [door] = await load(fakeAdapter({ storageId: '' }));
        assert.equal(door.icon, undefined);
    });

    it('"Record now" records through the path of the record button and updates the card', async () => {
        const adapter = fakeAdapter();
        const [door] = await load(adapter);
        const context = fakeContext();
        const answer = await action(door, 'record')('door', context);
        assert.deepEqual(adapter.taken, [{ camera: 'door', kind: 'record', request: {}, notify: [] }]);
        assert.equal(context.log[0][0], 'progress');
        assert.equal(context.log[0][1], DM_TEXTS.recording);
        assert.deepEqual(context.log[1], ['close']);
        assert.equal(context.log[2][1].de, 'Gespeichert: door_2026-11-11_09-05-07.mp4');
        assert.equal(answer.update.id, 'door');
        const lines = Object.values(answer.update.customInfo.schema.items).map(item => item.text);
        assert.equal(lines[0].en, 'Last clip: 11.11.2026 09:05:08');
    });

    it('"Snapshot" takes a picture and loads the new one', async () => {
        const adapter = fakeAdapter();
        const [door] = await load(adapter);
        const context = fakeContext();
        const answer = await action(door, 'snapshot')('door', context);
        assert.deepEqual(adapter.taken, [{ camera: 'door', kind: 'snapshot', request: {}, notify: [] }]);
        assert.equal(context.log[2][1].en, 'Saved: door_2026-11-11_09-05-07.jpg');
        assert.equal(answer.update.icon, `files/${NS}.storage/door.jpg?t=${SNAP_TIME + 1000}`);
    });

    it('shows the error of a failed recording and closes the progress', async () => {
        const [door] = await load(fakeAdapter({ fail: true }));
        const context = fakeContext();
        await action(door, 'record')('door', context);
        assert.deepEqual(context.log[1], ['close']);
        assert.equal(context.log[2][1].de, 'Fehlgeschlagen: camera "Door" is not reachable');
    });

    it('greys out record and snapshot of an offline camera, and refuses them on an old card', async () => {
        const adapter = fakeAdapter();
        const [oldCard] = await load(adapter);
        adapter.states['cameras.door.reachable'] = false;
        const [door, garden] = await load(adapter);
        for (const id of ['record', 'snapshot']) {
            assert.equal(action(door, id), undefined, id);
            assert.equal(door.actions.find((/** @type {any} */ a) => a.id === id).description, DM_TEXTS.offlineHint);
            assert.equal(typeof action(garden, id), 'function', id);
        }
        // the schedule stays editable
        assert.equal(typeof action(door, 'interval'), 'function');
        const context = fakeContext();
        const answer = await action(oldCard, 'snapshot')('door', context);
        assert.deepEqual(adapter.taken, []);
        assert.deepEqual(context.log, [['message', DM_TEXTS.offlineHint]]);
        assert.equal(action(answer.update, 'snapshot'), undefined);
        adapter.states['cameras.door.reachable'] = true;
        const [again] = await load(adapter);
        assert.equal(typeof action(again, 'record'), 'function');
    });

    it('answers a camera that was removed meanwhile', async () => {
        const adapter = fakeAdapter();
        const [door] = await load(adapter);
        const context = fakeContext();
        const answer = await action(door, 'record')('gone', context);
        assert.deepEqual(adapter.taken, []);
        assert.match(context.log[0][1].en, /unknown camera "gone"/);
        assert.deepEqual(answer, { refresh: 'devices' });
    });

    it('answers the messages of the Device Manager itself', async () => {
        const adapter = fakeAdapter();
        new CameraDeviceManagement(adapter);
        assert.equal(adapter.listeners.length, 1);
        adapter.listeners[0]({ command: 'dm:instanceInfo', message: {}, from: 'system.adapter.admin.0', callback: {} });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(adapter.sent.length, 1);
        assert.equal(adapter.sent[0][1], 'dm:instanceInfo');
        assert.equal(adapter.sent[0][2].apiVersion, 'v3');
        // other commands are left to the adapter
        adapter.listeners[0]({ command: 'listCameras', message: {}, from: 'x', callback: {} });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(adapter.sent.length, 1);
    });

    it('is announced in io-package.json together with the own messages', () => {
        const io = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'io-package.json'), 'utf8'));
        assert.deepEqual(io.common.supportedMessages, { custom: true, deviceManager: true });
        const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
        // the own onMessage must leave the "dm:" messages alone
        assert.match(main, /startsWith\('dm:'\)/);
    });

    it('has every text in all eleven languages', () => {
        for (const [key, text] of Object.entries(DM_TEXTS)) {
            assert.deepEqual(Object.keys(text).sort(), [...LANGS].sort(), key);
            for (const placeholder of text.en.match(/\{[a-z]+\}/g) || []) {
                for (const lang of LANGS) {
                    assert.ok(text[lang].includes(placeholder), `${key}.${lang} lost ${placeholder}`);
                }
            }
        }
    });
});
