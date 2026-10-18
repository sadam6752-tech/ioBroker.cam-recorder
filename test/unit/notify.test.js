'use strict';

const assert = require('node:assert/strict');
const { conditionMet } = require('../../lib/conditions');
const { buildMessage, KNOWN, parseNames, selectTargets } = require('../../lib/notify');
const { normalizeCameras, normalizeTriggers, normalizeSettings } = require('../../lib/config');

/** @type {import('../../lib/types').RecordResult} */
const clip = {
    file: '/opt/iobroker/iobroker-data/cam-recorder.0/media/door_2026-10-18_09-00-00.mp4',
    size: 1000,
    format: 'mp4',
    duration: 10,
    pre: 3,
    extended: 0,
    fromBuffer: true,
    realDuration: 10,
    camera: 'Door',
    time: 0,
};
const photo = { ...clip, file: clip.file.replace('.mp4', '.jpg'), format: /** @type {'jpg'} */ ('jpg'), duration: 0 };

/**
 * @param {string} instance - Instance
 * @param {string} [recipient] - Recipient
 * @param {string} [template] - Template
 * @returns {import('../../lib/types').NotifyTarget} Target
 */
const target = (instance, recipient = '', template = '', name = '') => ({ name, instance, recipient, template });

describe('trigger conditions', () => {
    it('compares booleans, numbers and texts', () => {
        assert.equal(conditionMet('eq', 'true', true), true);
        assert.equal(conditionMet('eq', 'false', true), false);
        assert.equal(conditionMet('eq', 'on', true), true);
        assert.equal(conditionMet('ne', 'true', false), true);
        assert.equal(conditionMet('eq', '2', 2), true);
        assert.equal(conditionMet('eq', '2,5', 2.5), true);
        assert.equal(conditionMet('gt', '20', 21), true);
        assert.equal(conditionMet('lt', '20', 21), false);
        assert.equal(conditionMet('eq', 'Away', 'away'), true);
        assert.equal(conditionMet('ne', 'home', 'away'), true);
    });

    it('never matches a missing value or a comparison of texts with > or <', () => {
        assert.equal(conditionMet('eq', 'true', null), false);
        assert.equal(conditionMet('ne', 'true', undefined), false);
        assert.equal(conditionMet('gt', 'abc', 5), false);
        assert.equal(conditionMet('gt', '', 5), false);
    });

    it('reads the condition columns of a trigger', () => {
        const { cameras } = normalizeCameras([{ name: 'Door', url: 'rtsp://h/1' }]);
        const { triggers } = normalizeTriggers(
            [
                {
                    stateId: 'a.0.ring',
                    camera: 'Door',
                    condState: ' 0_userdata.0.away ',
                    condOp: 'ne',
                    condValue: ' home ',
                },
                { stateId: 'a.0.ring2', camera: 'Door', condState: '', condOp: 'gt', condValue: '5' },
                { stateId: 'a.0.ring3', camera: 'Door', condState: 'x.0.y', condOp: 'nonsense', condValue: '1' },
            ],
            cameras,
        );
        assert.deepEqual(triggers[0].onlyIf, { stateId: '0_userdata.0.away', op: 'ne', value: 'home' });
        assert.equal(triggers[1].onlyIf, null);
        assert.equal(triggers[2].onlyIf?.op, 'eq');
    });
});

describe('recipients by name', () => {
    const me = target('max.0', '111', '', 'Alex');
    const fatherMax = target('max.0', '222', '', 'Father');
    const fatherMail = target('email.0', 'f@example.com', '', 'father');
    const unnamed = target('discord.0', '1/2');
    const all = [me, fatherMax, fatherMail, unnamed];

    it('reads a list of names', () => {
        assert.deepEqual(parseNames(' Alex, Father ;Telegram,, '), ['Alex', 'Father', 'Telegram']);
        assert.deepEqual(parseNames(['Alex', ' ']), ['Alex']);
        assert.deepEqual(parseNames(undefined), []);
    });

    it('sends to everybody without names', () => {
        assert.deepEqual(selectTargets([], all), { telegram: true, targets: all, unknown: [] });
    });

    it('sends only to the named targets, without case, Telegram included when named', () => {
        assert.deepEqual(selectTargets(['FATHER'], all), {
            telegram: false,
            targets: [fatherMax, fatherMail],
            unknown: [],
        });
        assert.deepEqual(selectTargets(['Alex', 'telegram'], all), { telegram: true, targets: [me], unknown: [] });
    });

    it('names unknown names, and a target without a name is only reached by an empty list', () => {
        const choice = selectTargets(['Alex', 'Mother'], all);
        assert.deepEqual(choice.targets, [me]);
        assert.deepEqual(choice.unknown, ['Mother']);
        assert.ok(!choice.targets.includes(unnamed));
    });

    it('reads the column Send to of a trigger', () => {
        const { cameras } = normalizeCameras([{ name: 'Door', url: 'rtsp://h/1' }]);
        const { triggers } = normalizeTriggers(
            [{ stateId: 'a.0.b', camera: 'Door', recipients: 'Father, Telegram' }],
            cameras,
        );
        assert.deepEqual(triggers[0].recipients, ['Father', 'Telegram']);
    });
});

describe('notification targets', () => {
    it('keeps active targets with an instance only', () => {
        const s = normalizeSettings({
            notifyTargets: [
                { enabled: true, instance: 'email.0', recipient: ' me@example.com ' },
                { enabled: false, instance: 'pushover.0' },
                { enabled: true, instance: '' },
            ],
        });
        assert.deepEqual(s.notifyTargets, [
            { name: '', instance: 'email.0', recipient: 'me@example.com', template: '' },
        ]);
    });

    it('sends the clip to Telegram as a path with caption and user', () => {
        assert.deepEqual(buildMessage(target('telegram.1', 'Alex'), clip, 'Door 09:00'), {
            command: 'send',
            message: { text: clip.file, caption: 'Door 09:00', user: 'Alex' },
        });
    });

    it('sends clips as video and pictures as image to MAX, to a user, a group chat or everybody', () => {
        assert.deepEqual(buildMessage(target('max.0', '123456'), clip, 'Door 09:00'), {
            command: 'send',
            message: { text: 'Door 09:00', video: clip.file, userId: 123456 },
        });
        assert.deepEqual(buildMessage(target('max.0', '-987654321'), photo, ''), {
            command: 'send',
            message: { image: photo.file, chatId: -987654321 },
        });
        assert.deepEqual(buildMessage(target('max.0'), photo, 'Door').message, { text: 'Door', image: photo.file });
    });

    it('attaches the clip to an email', () => {
        const { message } = buildMessage(target('email.0', 'me@example.com'), clip, 'Door 09:00');
        assert.equal(message.to, 'me@example.com');
        assert.equal(message.subject, 'Door 09:00');
        assert.deepEqual(message.attachments, [{ filename: 'door_2026-10-18_09-00-00.mp4', path: clip.file }]);
    });

    it('attaches pictures only to Pushover and Matrix, a clip becomes a text', () => {
        assert.equal(buildMessage(target('pushover.0'), photo, 'Door').message.file, photo.file);
        assert.equal(buildMessage(target('pushover.0'), clip, 'Door').message.file, undefined);
        assert.match(buildMessage(target('pushover.0'), clip, 'Door').message.message, /^Door: mp4 clip 10 s/);
        assert.equal(buildMessage(target('matrix-org.0'), photo, '').message.file, `file://${photo.file}`);
        assert.equal(typeof buildMessage(target('matrix-org.0'), clip, 'Door').message, 'string');
    });

    it('addresses Discord users and channels', () => {
        const toChannel = buildMessage(target('discord.0', '123/456'), clip, 'Door');
        assert.equal(toChannel.command, 'sendMessage');
        assert.equal(toChannel.message.serverId, '123');
        assert.equal(toChannel.message.channelId, '456');
        assert.deepEqual(toChannel.message.content.files, [
            { attachment: clip.file, name: 'door_2026-10-18_09-00-00.mp4' },
        ]);
        assert.equal(buildMessage(target('discord.0', '789'), clip, '').message.userId, '789');
        assert.equal(buildMessage(target('discord.0', 'alex#1'), clip, '').message.userTag, 'alex#1');
    });

    it('sends a text to messengers without files', () => {
        assert.deepEqual(buildMessage(target('signal-cmb.0', '+49123'), clip, 'Door'), {
            command: 'send',
            message: { text: 'Door: mp4 clip 10 s (door_2026-10-18_09-00-00.mp4)', phone: '+49123' },
        });
        assert.equal(buildMessage(target('gotify.0'), photo, 'Door').message.title, 'Door');
        assert.equal(buildMessage(target('ntfy.0', 'cams'), photo, 'Door').message.topic, 'cams');
    });

    it('fills a template, also with quotes in the caption', () => {
        const t = target('myapp.0', 'bob', '{"to":"{recipient}","body":"{caption}","attach":["{file}"],"n":5}');
        assert.deepEqual(buildMessage(t, clip, 'He said "hi"'), {
            command: 'send',
            message: { to: 'bob', body: 'He said "hi"', attach: [clip.file], n: 5 },
        });
    });

    it('refuses an unknown adapter without a template', () => {
        assert.throws(() => buildMessage(target('myapp.0'), clip, ''), /no message format known for "myapp"/);
        assert.ok(KNOWN.includes('email'));
    });
});
