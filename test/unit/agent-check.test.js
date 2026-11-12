'use strict';

const assert = require('node:assert/strict');
const {
    INSTRUCTIONS,
    needsAgent,
    conditionsOf,
    buildQuestion,
    parseVerdict,
    matchesOf,
    matchText,
} = require('../../lib/agent-check');
const { buildMessage } = require('../../lib/notify');
const { normalizeSettings } = require('../../lib/config');
const { HELP } = require('../../lib/help');

const settings = normalizeSettings({
    profiles: [
        { name: 'Alex', instance: 'telegram.0' },
        { name: 'Vet', instance: 'telegram.0' },
        { name: 'Also person', instance: 'email.0' },
        { name: 'Told', instance: 'max.0', text: '{camera}' },
        { name: 'Plain', instance: 'max.0', text: '{camera}' },
    ],
    agentChecks: [
        { enabled: true, criterion: ' a person ', profiles: 'alex, Also person' },
        { enabled: true, criterion: 'an animal', profiles: 'Vet' },
        { enabled: true, criterion: 'a car', profiles: 'Alex' },
        { enabled: false, criterion: 'a cat', profiles: 'Plain' },
        { enabled: true, criterion: '', profiles: 'Plain' },
        { enabled: true, criterion: 'nobody gets it', profiles: '' },
    ],
});
const { profiles } = settings;
const [alex, vet, alsoPerson, told, plain] = profiles;

describe('AI check of a snapshot', () => {
    it('gives each profile the criteria of the rows that name it, each criterion is asked once', () => {
        assert.deepEqual(
            profiles.map(p => p.conditions),
            [['a person', 'a car'], ['an animal'], ['a person'], [], []],
        );
        assert.deepEqual(settings.agentChecks.length, 3);
        assert.deepEqual(
            profiles.map(p => needsAgent(p)),
            [true, true, true, false, false],
        );
        assert.deepEqual(conditionsOf(profiles), ['a person', 'a car', 'an animal']);
    });

    it('takes only a pi-agent instance', () => {
        assert.equal(normalizeSettings({ agentInstance: 'pi-agent.0' }).agentInstance, 'pi-agent.0');
        assert.equal(normalizeSettings({ agentInstance: 'telegram.0' }).agentInstance, '');
        assert.equal(normalizeSettings({}).agentInstance, '');
        assert.equal(normalizeSettings({}).agentTimeout, 30);
        assert.equal(normalizeSettings({ agentTimeout: 1 }).agentTimeout, 5);
        assert.equal(normalizeSettings({ agentTimeout: 600 }).agentTimeout, 120);
    });

    it('numbers the criteria and asks for JSON in the language of the system', () => {
        const question = buildQuestion('Door', conditionsOf(profiles), 'ru');
        assert.match(question, /camera "Door"/);
        assert.match(question, /in Russian/);
        assert.match(question, /1\. a person\n2\. a car\n3\. an animal/);
        assert.match(question, /"matches": \[true or false, true or false, true or false\]/);
        assert.match(buildQuestion('Door', [], 'xx'), /in English[\s\S]*\{"description": "…"\}$/);
        assert.match(INSTRUCTIONS, /Do not call any tools/);
    });

    it('finds the criteria of each profile that the picture meets, also with text around the JSON', () => {
        const conditions = conditionsOf(profiles);
        const car = parseVerdict(
            'Here: {"description": "Ein Auto vor dem Tor", "matches": [false, true, false]} done',
            conditions,
        );
        assert.equal(car.description, 'Ein Auto vor dem Tor');
        assert.equal(car.error, '');
        assert.deepEqual(
            profiles.map(p => matchesOf(p, car)),
            [['a car'], [], [], [], []],
        );
        const both = parseVerdict('{"description": "", "matches": [true, true, "true"]}', conditions);
        assert.deepEqual(
            profiles.map(p => matchesOf(p, both)),
            [['a person', 'a car'], ['an animal'], ['a person'], [], []],
        );
    });

    it('finds no match when the answer cannot be read or the check did not run', () => {
        const conditions = conditionsOf(profiles);
        const prose = parseVerdict('I see a cat on the steps.', conditions);
        assert.equal(prose.description, 'I see a cat on the steps.');
        assert.match(prose.error, /no JSON/);
        assert.deepEqual(matchesOf(vet, prose), []);
        // a criterion without a decision is no match
        const short = parseVerdict('{"description": "x", "matches": [true, false]}', conditions);
        assert.deepEqual(matchesOf(alsoPerson, short), ['a person']);
        assert.deepEqual(matchesOf(vet, short), []);
        assert.match(short.error, /an animal/);
        assert.equal(parseVerdict('', conditions).error, 'empty answer');
        assert.deepEqual(matchesOf(alex, null), []);
    });

    it('writes the extra message in one line, through the format of the profile', () => {
        const text = matchText('Door', ['a person', 'a car'], ' A man\n with a $& parcel. ');
        assert.equal(text, '🔍 Door: a person, a car — A man with a $& parcel.');
        assert.equal(matchText('Door', ['a person'], ''), '🔍 Door: a person');
        assert.deepEqual(buildMessage(alex, null, text, 'Door'), { command: 'send', message: { text } });
    });
});

describe('help for AI agents', () => {
    it('names every command of onMessage', () => {
        for (const command of ['help', 'listCameras', 'listProfiles', 'snapshot', 'record', 'timelapse']) {
            assert.ok(
                HELP.includes(`
- ${command}`),
                command,
            );
        }
        assert.ok(HELP.length < 6000);
    });
});
