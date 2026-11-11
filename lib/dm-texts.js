'use strict';

/**
 * Texts of the Device Manager cards in the eleven languages of ioBroker.
 *
 * @type {Record<string, ioBroker.Translated>}
 */
const DM_TEXTS = {
    recordNow: {
        en: 'Record now',
        de: 'Aufnahme jetzt',
        ru: 'Записать сейчас',
        pt: 'Gravar agora',
        nl: 'Nu opnemen',
        fr: 'Enregistrer maintenant',
        it: 'Registra ora',
        es: 'Grabar ahora',
        pl: 'Nagraj teraz',
        uk: 'Записати зараз',
        'zh-cn': '立即录制',
    },
    recordNowHint: {
        en: 'Records a video clip with the length and format of the Recording tab',
        de: 'Nimmt einen Videoclip mit Länge und Format des Reiters Aufnahme auf',
        ru: 'Записывает видеоклип с длиной и форматом со вкладки «Запись»',
        pt: 'Grava um clipe de vídeo com a duração e o formato da aba Gravação',
        nl: 'Neemt een videoclip op met de lengte en het formaat van het tabblad Opname',
        fr: "Enregistre un clip vidéo avec la durée et le format de l'onglet Enregistrement",
        it: 'Registra una clip video con la durata e il formato della scheda Registrazione',
        es: 'Graba un videoclip con la duración y el formato de la pestaña Grabación',
        pl: 'Nagrywa klip wideo o długości i formacie z karty Nagrywanie',
        uk: 'Записує відеокліп із довжиною та форматом із вкладки «Запис»',
        'zh-cn': '按“录制”选项卡的时长和格式录制视频片段',
    },
    snapshot: {
        en: 'Snapshot',
        de: 'Schnappschuss',
        ru: 'Снимок',
        pt: 'Instantâneo',
        nl: 'Momentopname',
        fr: 'Photo',
        it: 'Istantanea',
        es: 'Instantánea',
        pl: 'Zdjęcie',
        uk: 'Знімок',
        'zh-cn': '快照',
    },
    snapshotHint: {
        en: 'Takes a picture (JPEG)',
        de: 'Nimmt ein Bild auf (JPEG)',
        ru: 'Делает снимок (JPEG)',
        pt: 'Tira uma foto (JPEG)',
        nl: 'Maakt een foto (JPEG)',
        fr: 'Prend une photo (JPEG)',
        it: 'Scatta una foto (JPEG)',
        es: 'Toma una foto (JPEG)',
        pl: 'Robi zdjęcie (JPEG)',
        uk: 'Робить знімок (JPEG)',
        'zh-cn': '拍摄一张照片（JPEG）',
    },
    recording: {
        en: 'Recording',
        de: 'Aufnahme läuft',
        ru: 'Идёт запись',
        pt: 'Gravando',
        nl: 'Neemt op',
        fr: 'Enregistrement en cours',
        it: 'Registrazione in corso',
        es: 'Grabando',
        pl: 'Nagrywanie',
        uk: 'Іде запис',
        'zh-cn': '正在录制',
    },
    takingSnapshot: {
        en: 'Taking a snapshot',
        de: 'Schnappschuss läuft',
        ru: 'Делается снимок',
        pt: 'Tirando instantâneo',
        nl: 'Momentopname wordt gemaakt',
        fr: 'Photo en cours',
        it: 'Istantanea in corso',
        es: 'Tomando instantánea',
        pl: 'Robienie zdjęcia',
        uk: 'Робиться знімок',
        'zh-cn': '正在拍摄快照',
    },
    saved: {
        en: 'Saved: {file}',
        de: 'Gespeichert: {file}',
        ru: 'Сохранено: {file}',
        pt: 'Guardado: {file}',
        nl: 'Opgeslagen: {file}',
        fr: 'Enregistré : {file}',
        it: 'Salvato: {file}',
        es: 'Guardado: {file}',
        pl: 'Zapisano: {file}',
        uk: 'Збережено: {file}',
        'zh-cn': '已保存：{file}',
    },
    failed: {
        en: 'Failed: {error}',
        de: 'Fehlgeschlagen: {error}',
        ru: 'Не удалось: {error}',
        pt: 'Falhou: {error}',
        nl: 'Mislukt: {error}',
        fr: 'Échec : {error}',
        it: 'Non riuscito: {error}',
        es: 'Error: {error}',
        pl: 'Niepowodzenie: {error}',
        uk: 'Не вдалося: {error}',
        'zh-cn': '失败：{error}',
    },
    lastClip: {
        en: 'Last clip: {time}',
        de: 'Letzter Clip: {time}',
        ru: 'Последний клип: {time}',
        pt: 'Último clipe: {time}',
        nl: 'Laatste clip: {time}',
        fr: 'Dernier clip : {time}',
        it: 'Ultima clip: {time}',
        es: 'Último clip: {time}',
        pl: 'Ostatni klip: {time}',
        uk: 'Останній кліп: {time}',
        'zh-cn': '最近片段：{time}',
    },
    lastSnapshot: {
        en: 'Last snapshot: {time}',
        de: 'Letzter Schnappschuss: {time}',
        ru: 'Последний снимок: {time}',
        pt: 'Último instantâneo: {time}',
        nl: 'Laatste momentopname: {time}',
        fr: 'Dernière photo : {time}',
        it: 'Ultima istantanea: {time}',
        es: 'Última instantánea: {time}',
        pl: 'Ostatnie zdjęcie: {time}',
        uk: 'Останній знімок: {time}',
        'zh-cn': '最近快照：{time}',
    },
    never: {
        en: 'none yet',
        de: 'noch keiner',
        ru: 'пока нет',
        pt: 'ainda nenhum',
        nl: 'nog geen',
        fr: 'aucun pour le moment',
        it: 'ancora nessuno',
        es: 'todavía ninguno',
        pl: 'jeszcze brak',
        uk: 'поки немає',
        'zh-cn': '暂无',
    },
    preRecording: {
        en: 'Pre-recording {seconds} s',
        de: 'Voraufnahme {seconds} s',
        ru: 'Предзапись {seconds} с',
        pt: 'Pré-gravação {seconds} s',
        nl: 'Vooropname {seconds} s',
        fr: 'Pré-enregistrement {seconds} s',
        it: 'Pre-registrazione {seconds} s',
        es: 'Pregrabación {seconds} s',
        pl: 'Nagrywanie wstępne {seconds} s',
        uk: 'Попередній запис {seconds} с',
        'zh-cn': '预录 {seconds} 秒',
    },
};

/**
 * @param {ioBroker.Translated} text - Text in all languages
 * @param {Record<string, string | ioBroker.Translated>} values - Values for `{name}`, plain or per language
 * @returns {ioBroker.Translated} The text with the values filled in, in every language
 */
function fillText(text, values) {
    /**
     * @param {string} lang - Language
     * @param {string} name - Placeholder
     * @returns {string | undefined} Value in that language
     */
    const value = (lang, name) => {
        const v = values[name];
        if (v === undefined || typeof v === 'string') {
            return v;
        }
        return /** @type {Record<string, string>} */ (v)[lang] ?? v.en;
    };
    return /** @type {ioBroker.Translated} */ (
        Object.fromEntries(
            Object.entries(text).map(([lang, s]) => [
                lang,
                s.replace(/\{(\w+)\}/g, (all, name) => value(lang, name) ?? all),
            ]),
        )
    );
}

module.exports = { DM_TEXTS, fillText };
