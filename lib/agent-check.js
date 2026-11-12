'use strict';

/**
 * Check of a snapshot by an AI agent (ioBroker.pi-agent): the agent describes the picture and says for every criterion
 * of the tab AI check ("a person") whether the picture meets it. A profile with a criterion that is met gets an extra
 * message; the files of the event go out as before, whatever the check says. One question per event, however many
 * profiles; pi-agent sends the picture to its model only with this question and keeps a text of it afterwards.
 */

/**
 * @typedef {import('./types').NotifyProfile} NotifyProfile
 */

/** Instructions of the conversation of each camera in pi-agent. */
const INSTRUCTIONS =
    'You check pictures of security cameras for the ioBroker adapter cam-recorder. Judge only the picture of the ' +
    'current message, never earlier ones. Do not call any tools. Answer with the JSON the message asks for and ' +
    'nothing else.';

/** Longest description kept, in characters. */
const MAX_DESCRIPTION = 500;

/** Names of the languages of ioBroker, for the description. */
const LANGUAGES = {
    en: 'English',
    de: 'German',
    ru: 'Russian',
    pt: 'Portuguese',
    nl: 'Dutch',
    fr: 'French',
    it: 'Italian',
    es: 'Spanish',
    pl: 'Polish',
    uk: 'Ukrainian',
    'zh-cn': 'Chinese',
};

/**
 * @param {NotifyProfile} profile - Profile
 * @returns {boolean} Whether the profile needs the agent: it has criteria of the tab AI check
 */
function needsAgent(profile) {
    return profile.conditions.length > 0;
}

/**
 * The conditions of the profiles, each text once.
 *
 * @param {NotifyProfile[]} profiles - Profiles of the event
 * @returns {string[]} Conditions in the order of the profiles
 */
function conditionsOf(profiles) {
    return [...new Set(profiles.flatMap(p => p.conditions))];
}

/**
 * The question to the agent.
 *
 * @param {string} camera - Camera name
 * @param {string[]} conditions - Conditions to decide
 * @param {string} language - Language of the system, e.g. "de"
 * @returns {string} Text of the question
 */
function buildQuestion(camera, conditions, language) {
    const lang = LANGUAGES[/** @type {keyof typeof LANGUAGES} */ (language)] || 'English';
    const lines = [
        `Picture of the camera "${camera}", taken just now.`,
        `Describe in one short sentence in ${lang} what the picture shows: people, animals, vehicles, what happens.`,
    ];
    if (conditions.length) {
        lines.push(
            'Decide for each numbered condition whether the picture meets it (true or false):',
            ...conditions.map((c, i) => `${i + 1}. ${c}`),
            `Answer only with this JSON: {"description": "…", "matches": [${conditions.map(() => 'true or false').join(', ')}]}`,
        );
    } else {
        lines.push('Answer only with this JSON: {"description": "…"}');
    }
    return lines.join('\n');
}

/**
 * @typedef {object} Verdict
 * @property {string} description - What the picture shows, '' when unknown
 * @property {Map<string, boolean>} matches - Criterion → met; a missing one was not decided
 * @property {string} error - Why the check failed, '' when it worked
 */

/**
 * Reads the answer of the agent. A criterion it did not decide is no match.
 *
 * @param {unknown} answer - `answer` of pi-agent
 * @param {string[]} conditions - Conditions of the question
 * @returns {Verdict} The verdict
 */
function parseVerdict(answer, conditions) {
    const text = String(answer ?? '').trim();
    /** @type {Map<string, boolean>} */
    const matches = new Map();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    /** @type {Record<string, unknown> | null} */
    let data = null;
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            data = null;
        }
    }
    if (!data) {
        return {
            description: text.slice(0, MAX_DESCRIPTION),
            matches,
            error: text ? 'the answer is no JSON' : 'empty answer',
        };
    }
    const list = Array.isArray(data.matches) ? data.matches : [];
    conditions.forEach((condition, i) => {
        const value = list[i];
        if (typeof value === 'boolean') {
            matches.set(condition, value);
        } else if (value === 'true' || value === 'false') {
            matches.set(condition, value === 'true');
        }
    });
    const missing = conditions.filter(c => !matches.has(c));
    return {
        description: String(data.description ?? '')
            .trim()
            .slice(0, MAX_DESCRIPTION),
        matches,
        error: missing.length ? `no decision for ${missing.map(c => `"${c}"`).join(', ')}` : '',
    };
}

/**
 * The criteria of a profile that the picture meets; a criterion without a decision is not a match.
 *
 * @param {NotifyProfile} profile - Profile
 * @param {Verdict | null} verdict - Verdict of the event, null = no check
 * @returns {string[]} Criteria met, empty = no extra message
 */
function matchesOf(profile, verdict) {
    return verdict ? profile.conditions.filter(c => verdict.matches.get(c) === true) : [];
}

/**
 * Text of the extra message about a match, one line (it is also the subject of an email).
 *
 * @param {string} camera - Camera name
 * @param {string[]} matched - Criteria met
 * @param {string} description - What the agent saw
 * @returns {string} e.g. "🔍 Door: a person — A man with a parcel at the door."
 */
function matchText(camera, matched, description) {
    const line = description.replace(/\s+/g, ' ').trim();
    return `🔍 ${camera}: ${matched.join(', ')}${line ? ` — ${line}` : ''}`;
}

module.exports = { INSTRUCTIONS, needsAgent, conditionsOf, buildQuestion, parseVerdict, matchesOf, matchText };
