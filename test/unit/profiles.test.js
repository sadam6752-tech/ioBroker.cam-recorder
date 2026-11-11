'use strict';

const assert = require('node:assert/strict');
const {
    normalizeProfiles,
    profileProblems,
    pickProfiles,
    planNotify,
    profileMessage,
    needsMigration,
    migrateNotify,
} = require('../../lib/profiles');
const { normalizeSettings, normalizeTriggers, normalizeCameras, normalizeTimelapses } = require('../../lib/config');

/** @type {import('../../lib/types').RecordResult} */
const clip = {
    file: '/media/door_2026-10-18_09-00-00.mp4',
    size: 1000,
    format: 'mp4',
    duration: 10,
    pre: 0,
    extended: 0,
    fromBuffer: false,
    realDuration: 10,
    camera: 'Door',
    time: new Date(2026, 9, 18, 9, 0, 0).getTime(),
};
const photo = { ...clip, file: '/media/door.jpg', format: /** @type {'jpg'} */ ('jpg') };

/** Settings of a 0.4.x instance: Telegram instance, three further targets, a trigger per way of use. */
const legacy = () => ({
    telegramInstance: 'telegram.0',
    telegramUser: 'Alex',
    telegramCaption: 'Door {time}',
    notifyTargets: [
        { enabled: true, name: 'Father', instance: 'max.0', recipient: '222', template: '' },
        { enabled: true, name: '', instance: 'email.0', recipient: 'me@example.com', template: '' },
        { enabled: false, name: 'Old', instance: 'pushover.0', recipient: '', template: '' },
        // the same target twice under another name
        { enabled: true, name: 'Papa', instance: 'max.0', recipient: '222', template: '' },
    ],
    triggers: [
        { stateId: 'bell.all', camera: 'Door', telegram: true, recipients: '' },
        { stateId: 'bell.father', camera: 'Door', telegram: true, recipients: 'father, Telegram' },
        { stateId: 'motion', camera: 'Door', telegram: false, recipients: 'Father' },
        { stateId: 'bell.default', camera: 'Door' },
        { stateId: 'bell.papa', camera: 'Door', recipients: 'Papa, Nobody' },
    ],
    timelapses: [
        { camera: 'Door', notify: true, recipients: 'Father' },
        { camera: 'Garden', notify: false },
    ],
    cameras: [{ name: 'Door', url: 'rtsp://h/1', password: 'kept' }],
});

describe('notification profiles', () => {
    it('keeps active profiles with name and instance, the first of equal names wins', () => {
        const rows = [
            { enabled: true, name: ' Alex ', instance: 'telegram.0', recipient: ' Alex ', attach: 'clip', text: 'x' },
            { enabled: true, name: 'alex', instance: 'max.0' },
            { enabled: false, name: 'Off', instance: 'max.0' },
            { enabled: true, name: '', instance: 'max.0' },
            { enabled: true, name: 'NoInstance', instance: '' },
            { name: 'Mail', instance: 'email.0', attach: 'weird' },
        ];
        assert.deepEqual(normalizeProfiles(rows), [
            { name: 'Alex', instance: 'telegram.0', recipient: 'Alex', attach: 'clip', text: 'x', template: '' },
            { name: 'Mail', instance: 'email.0', recipient: '', attach: 'all', text: '', template: '' },
        ]);
        assert.equal(profileProblems(rows).length, 3);
        assert.deepEqual(normalizeSettings({ profiles: rows }).profiles, normalizeProfiles(rows));
    });

    it('picks profiles by name without case and names unknown ones', () => {
        const profiles = normalizeProfiles([
            { name: 'Alex', instance: 'telegram.0' },
            { name: 'Father', instance: 'max.0' },
        ]);
        const { chosen, unknown } = pickProfiles(['father', 'Mother', 'Father'], profiles);
        assert.deepEqual(
            chosen.map(p => p.name),
            ['Father'],
        );
        assert.deepEqual(unknown, ['Mother']);
    });

    it('sends each kind of file only through the profiles that want it', () => {
        const profiles = normalizeProfiles([
            { name: 'All', instance: 'telegram.0' },
            { name: 'Pics', instance: 'max.0', attach: 'snapshot' },
            { name: 'Clips', instance: 'email.0', attach: 'clip' },
            { name: 'Ping', instance: 'pushover.0', attach: 'none' },
        ]);
        const names = ['All', 'Pics', 'Clips', 'Ping'];
        const plan = (/** @type {any} */ result) =>
            planNotify(names, profiles, result).map(s => `${s.profile.name}:${s.result ? s.result.format : 'text'}`);
        assert.deepEqual(plan(photo), ['All:jpg', 'Pics:jpg', 'Ping:text']);
        assert.deepEqual(plan(clip), ['All:mp4', 'Clips:mp4', 'Ping:text']);
        assert.deepEqual(plan({ ...clip, format: 'gif' }), ['All:gif', 'Clips:gif', 'Ping:text']);
        assert.deepEqual(planNotify([], profiles, clip), []);
    });

    it('builds the message of a profile with its text as caption', () => {
        const [telegram, max, ping] = normalizeProfiles([
            { name: 'Alex', instance: 'telegram.0', recipient: 'Alex', text: '{camera} at {time}' },
            { name: 'Group', instance: 'max.0', recipient: '-42', text: '' },
            { name: 'Ping', instance: 'telegram.1', attach: 'none', text: 'Someone at the {camera}' },
        ]);
        const time = new Date(clip.time);
        assert.deepEqual(profileMessage(telegram, clip, 'Door', time), {
            command: 'send',
            message: { text: clip.file, caption: 'Door at 09:00:00', user: 'Alex' },
        });
        assert.deepEqual(profileMessage(max, photo, 'Door', time), {
            command: 'send',
            message: { image: photo.file, chatId: -42 },
        });
        assert.deepEqual(profileMessage(ping, null, 'Door', time), {
            command: 'send',
            message: { text: 'Someone at the Door' },
        });
    });
});

describe('migration of the notification settings of 0.4.x', () => {
    it('is needed only for old settings that were not migrated yet', () => {
        assert.equal(needsMigration(legacy()), true);
        assert.equal(needsMigration({ ...legacy(), profilesMigrated: true }), false);
        // a new installation and settings saved by the new admin
        assert.equal(needsMigration({ telegramInstance: '', notifyTargets: [], triggers: [], timelapses: [] }), false);
        assert.equal(needsMigration({ triggers: [{ stateId: 'a', profiles: '' }] }), false);
        // a trigger without the old columns notified before (default true)
        assert.equal(needsMigration({ triggers: [{ stateId: 'a' }] }), true);
        assert.equal(needsMigration({ triggers: [{ stateId: 'a', telegram: false }] }), false);
        assert.equal(needsMigration({ timelapses: [{ camera: 'Door', notify: true }] }), true);
        assert.equal(needsMigration({ notifyTargets: { 0: { instance: 'max.0' } } }), true);
    });

    it('turns the Telegram instance and the targets into profiles, identical ones once', () => {
        const { profiles } = migrateNotify(legacy());
        assert.deepEqual(profiles, [
            {
                enabled: true,
                name: 'Telegram',
                instance: 'telegram.0',
                recipient: 'Alex',
                template: '',
                attach: 'all',
                text: 'Door {time}',
            },
            {
                enabled: true,
                name: 'Father',
                instance: 'max.0',
                recipient: '222',
                template: '',
                attach: 'all',
                text: 'Door {time}',
            },
            {
                enabled: true,
                name: 'email.0 me@example.com',
                instance: 'email.0',
                recipient: 'me@example.com',
                template: '',
                attach: 'all',
                text: 'Door {time}',
            },
            {
                enabled: false,
                name: 'Old',
                instance: 'pushover.0',
                recipient: '',
                template: '',
                attach: 'all',
                text: 'Door {time}',
            },
        ]);
    });

    it('sets each trigger and timelapse to the profiles it sent to before', () => {
        const { triggers, timelapses, profilesMigrated } = migrateNotify(legacy());
        assert.equal(profilesMigrated, true);
        assert.deepEqual(
            triggers.map(t => t.profiles),
            [
                // empty "Send to" = Telegram and every active target
                'Telegram, Father, email.0 me@example.com',
                'Father, Telegram',
                '',
                'Telegram, Father, email.0 me@example.com',
                // "Papa" was the same target as "Father", an unknown name is dropped
                'Father',
            ],
        );
        assert.deepEqual(
            timelapses.map(t => t.profiles),
            ['Father', ''],
        );
        // the other columns stay
        assert.equal(triggers[1].recipients, 'father, Telegram');
        assert.equal(triggers[2].telegram, false);
    });

    it('gives the same result as before through the new runtime', () => {
        const native = { ...legacy(), ...migrateNotify(legacy()) };
        const settings = normalizeSettings(native);
        const { cameras } = normalizeCameras(native.cameras);
        const { triggers } = normalizeTriggers(native.triggers, cameras);
        const sent = triggers.map(t =>
            planNotify(t.profiles, settings.profiles, clip).map(s => `${s.profile.instance}/${s.profile.recipient}`),
        );
        assert.deepEqual(sent, [
            ['telegram.0/Alex', 'max.0/222', 'email.0/me@example.com'],
            ['max.0/222', 'telegram.0/Alex'],
            [],
            ['telegram.0/Alex', 'max.0/222', 'email.0/me@example.com'],
            ['max.0/222'],
        ]);
        const { jobs } = normalizeTimelapses(native.timelapses, cameras);
        assert.deepEqual(jobs[0].profiles, ['Father']);
    });

    it('runs once and loses nothing', () => {
        const before = legacy();
        const after = { ...before, ...migrateNotify(before) };
        assert.equal(needsMigration(after), false);
        // keys of the old version stay for a downgrade, the cameras are not touched
        assert.equal(after.telegramInstance, 'telegram.0');
        assert.equal(after.notifyTargets.length, 4);
        assert.deepEqual(after.cameras, before.cameras);
        // a second run, should it happen, changes nothing
        const again = migrateNotify({ ...after, profilesMigrated: false });
        assert.deepEqual(again.profiles, after.profiles);
        assert.deepEqual(again.triggers, after.triggers);
        assert.deepEqual(again.timelapses, after.timelapses);
    });

    it('keeps profiles and rows made in the new admin before the first start', () => {
        const native = {
            ...legacy(),
            profiles: [{ enabled: true, name: 'Telegram', instance: 'telegram.1', attach: 'clip', text: '' }],
            triggers: [
                { stateId: 'new', camera: 'Door', profiles: 'Telegram' },
                { stateId: 'old', camera: 'Door', telegram: true, recipients: 'Telegram' },
            ],
        };
        const { profiles, triggers } = migrateNotify(native);
        assert.deepEqual(profiles[0], native.profiles[0]);
        assert.equal(profiles[1].name, 'Telegram 2');
        assert.equal(profiles[1].instance, 'telegram.0');
        assert.deepEqual(
            triggers.map(t => t.profiles),
            ['Telegram', 'Telegram 2'],
        );
    });
});
