'use strict';

/* eslint-disable jsdoc/reject-any-type -- rows are raw admin values, every caller checks each field */
/**
 * Rows of a table of the settings. A table that the instance object did not have before can
 * arrive as an object with the keys "0", "1", … when it is merged into an older object.
 *
 * @param {unknown} list - Table value
 * @returns {Record<string, any>[]} The rows (values as the admin stored them, checked by the callers)
 */
function tableRows(list) {
    if (Array.isArray(list)) {
        return list;
    }
    return list && typeof list === 'object' ? Object.values(list) : [];
}
/* eslint-enable jsdoc/reject-any-type */

module.exports = { tableRows };
