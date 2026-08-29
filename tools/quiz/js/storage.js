// storage.js — ErrorLog, merge idempotente, localStorage, export/import.
//
// La parte di merge/aggregazione è PURA (importabile da Node): tutte le
// funzioni che toccano localStorage lo fanno in modo pigro e protetto, quindi
// il modulo si importa senza errori anche fuori dal browser.
//
// Modello:
//   ErrorLog = { version, exam, updatedAt, sessions:[Attempt…], perQuestion:{…} }
// `sessions` è la FONTE DI VERITÀ; `perQuestion` è SEMPRE ricomputato dalle
// sessions ⇒ import/export ripetuti sono idempotenti (unione per `uid`, poi
// ricalcolo): nessun contatore viene mai sommato due volte.
//
// Due formati di export, con ruoli diversi:
//   - ErrorLog di un singolo esame  → si committa in exams/<slug>/quiz-errori.json
//     e viene reimportato da solo al boot (discovery.fetchRemoteLog);
//   - Backup multi-esame            → { format, version, exportedAt, prefs,
//     exams: {slug: ErrorLog} }, per salvare tutto in un colpo prima di un
//     rifacimento del lab. Entrambi rientrano dallo stesso import.

import { SIM_TOTAL } from './engine.js';

export const VERSION = 1;
export const PREFIX = 'lm77quiz.v1';
export const SESSION_CAP = 100;
export const BACKUP_FORMAT = 'lm77quiz-backup';

// ---------------------------------------------------------------------------
// Parte pura
// ---------------------------------------------------------------------------

export function emptyLog(exam = '') {
  return { version: VERSION, exam, updatedAt: null, sessions: [], perQuestion: {} };
}

/** Normalizza un oggetto arbitrario (da JSON/localStorage) in un ErrorLog. */
export function normalizeLog(raw, exam = '') {
  if (!raw || typeof raw !== 'object') return emptyLog(exam);
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(isAttempt) : [];
  return rebuild(raw.exam || exam, sessions);
}

function isAttempt(s) {
  return !!s && typeof s === 'object' && typeof s.uid === 'string' && Array.isArray(s.items);
}

function tsOf(s) {
  const t = Date.parse(s && s.ts);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Come mergeLogs, ma riporta anche che cosa è successo:
 *   added   — sessioni presenti in `incoming` e non in `base`;
 *   dropped — sessioni scartate dal cap (le più VECCHIE dell'unione).
 * `dropped` va mostrato all'utente: importare un archivio lungo può abbassare i
 * contatori di `perQuestion`, e senza segnalazione sembrerebbe una perdita muta.
 */
export function mergeLogsWithStats(base, incoming, opts = {}) {
  const cap = opts.cap || SESSION_CAP;
  const baseSessions = ((base && base.sessions) || []).filter(isAttempt);
  const incomingSessions = ((incoming && incoming.sessions) || []).filter(isAttempt);
  const byUid = new Map();
  for (const s of [...baseSessions, ...incomingSessions]) {
    if (!byUid.has(s.uid)) byUid.set(s.uid, s);
  }
  const baseUids = new Set(baseSessions.map((s) => s.uid));
  let added = 0;
  for (const uid of byUid.keys()) if (!baseUids.has(uid)) added += 1;

  const sessions = Array.from(byUid.values()).sort((a, b) => tsOf(a) - tsOf(b) || (a.uid < b.uid ? -1 : 1));
  const capped = sessions.slice(Math.max(0, sessions.length - cap));
  const exam = (base && base.exam) || (incoming && incoming.exam) || '';
  return { log: rebuild(exam, capped), added, dropped: sessions.length - capped.length };
}

/**
 * Unione di due ErrorLog per `uid`, con ricalcolo completo di `perQuestion`.
 * Idempotente: mergeLogs(a, a) è profondamente uguale a normalizeLog(a).
 */
export function mergeLogs(base, incoming, opts = {}) {
  return mergeLogsWithStats(base, incoming, opts).log;
}

function rebuild(exam, sessions) {
  const sorted = Array.from(sessions).sort((a, b) => tsOf(a) - tsOf(b) || (a.uid < b.uid ? -1 : 1));
  const last = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    version: VERSION,
    exam: exam || '',
    // Deterministico (ts dell'ultima sessione): due merge identici producono
    // due oggetti identici, condizione dell'idempotenza.
    updatedAt: last ? last.ts : null,
    sessions: sorted,
    perQuestion: recomputePerQuestion(sorted),
  };
}

/** Ricostruisce le statistiche per domanda a partire dalle sole sessioni. */
export function recomputePerQuestion(sessions) {
  const per = {};
  const sorted = Array.from(sessions || []).sort((a, b) => tsOf(a) - tsOf(b) || (a.uid < b.uid ? -1 : 1));
  for (const session of sorted) {
    for (const item of session.items || []) {
      if (!item || !item.id) continue;
      const e = per[item.id] || (per[item.id] = {
        type: item.type || 'mcq',
        lesson: item.lesson || null,
        seen: 0,
        wrong: 0,
        lastSeenAt: null,
        lastWrongAt: null,
        lastResult: null,
        streakCorrect: 0,
        textSnapshot: null,
        contentHash: null,
      });
      e.seen += 1;
      e.lastSeenAt = session.ts || e.lastSeenAt;
      if (item.correct) {
        e.streakCorrect += 1;
        e.lastResult = 'corretta';
      } else {
        e.wrong += 1;
        e.streakCorrect = 0;
        e.lastResult = 'errata';
        e.lastWrongAt = session.ts || e.lastWrongAt;
      }
      if (item.text) e.textSnapshot = item.text;
      if (item.lesson) e.lesson = item.lesson;
      if (item.contentHash) e.contentHash = item.contentHash;
    }
  }
  return per;
}

/** Aggiunge un tentativo restituendo un nuovo ErrorLog (non muta l'input). */
export function addAttempt(log, attempt) {
  return mergeLogs(log, { exam: attempt && attempt.exam, sessions: [attempt] });
}

export function newUid(now = Date.now(), rand = Math.random) {
  return `${now}-${Math.floor(rand() * 1e9).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Backup multi-esame (puro)
// ---------------------------------------------------------------------------

/**
 * Costruisce il backup di TUTTI gli esami più le preferenze.
 * `exportedAt` è un parametro e non `Date.now()`: la funzione resta pura e
 * testabile, e chi chiama decide se datare il file.
 */
export function buildBackup(logsBySlug, prefs = null, exportedAt = null) {
  const exams = {};
  for (const slug of Object.keys(logsBySlug || {}).sort()) {
    exams[slug] = normalizeLog(logsBySlug[slug], slug);
  }
  return {
    format: BACKUP_FORMAT,
    version: VERSION,
    exportedAt: exportedAt || null,
    prefs: prefs && typeof prefs === 'object' ? { ...prefs } : null,
    exams,
  };
}

export function isBackup(raw) {
  return !!raw && typeof raw === 'object' && raw.format === BACKUP_FORMAT
    && !!raw.exams && typeof raw.exams === 'object' && !Array.isArray(raw.exams);
}

/**
 * Backup → { prefs, exams: {slug: ErrorLog} } normalizzati.
 * Restituisce null se `raw` non è un backup: è così che l'import distingue i
 * due formati senza doverli sondare a mano.
 */
export function parseBackup(raw) {
  if (!isBackup(raw)) return null;
  const exams = {};
  for (const [slug, log] of Object.entries(raw.exams)) {
    if (typeof slug !== 'string' || !slug) continue;
    exams[slug] = normalizeLog(log, slug);
  }
  return { prefs: raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : null, exams };
}

export function serializeBackup(backup) {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * Slug degli esami presenti fra CHIAVI arbitrarie di localStorage. Puro, così
 * lo smoke-test può verificarlo senza uno stub di localStorage; `listExams()`
 * qui sotto è solo il wrapper che legge le chiavi vere.
 */
export function examsFromKeys(keys) {
  const prefix = `${PREFIX}.history.`;
  const out = [];
  for (const key of keys || []) {
    if (typeof key !== 'string') continue;
    if (!key.startsWith(prefix) || key.length === prefix.length) continue;
    out.push(key.slice(prefix.length));
  }
  return out.sort();
}

/** Riepilogo per la schermata di configurazione. */
export function summarize(log) {
  const per = (log && log.perQuestion) || {};
  const ids = Object.keys(per);
  return {
    sessions: ((log && log.sessions) || []).length,
    tracked: ids.length,
    wrong: ids.filter((id) => (per[id].wrong || 0) > 0).length,
    lastAt: (log && log.updatedAt) || null,
  };
}

// ---------------------------------------------------------------------------
// Parte browser (protetta: importabile anche da Node)
// ---------------------------------------------------------------------------

function store() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch (err) {
    return null;
  }
}

export function historyKey(exam) {
  return `${PREFIX}.history.${exam}`;
}

/** Slug di tutti gli esami con uno storico in localStorage. */
export function listExams() {
  const ls = store();
  if (!ls) return [];
  try {
    const keys = [];
    for (let i = 0; i < ls.length; i += 1) keys.push(ls.key(i));
    return examsFromKeys(keys);
  } catch (err) {
    return [];
  }
}

export function loadLog(exam) {
  const ls = store();
  if (!ls) return emptyLog(exam);
  try {
    const raw = ls.getItem(historyKey(exam));
    return raw ? normalizeLog(JSON.parse(raw), exam) : emptyLog(exam);
  } catch (err) {
    return emptyLog(exam);
  }
}

export function saveLog(exam, log) {
  const ls = store();
  if (!ls) return false;
  try {
    ls.setItem(historyKey(exam), JSON.stringify(log));
    return true;
  } catch (err) {
    // quota superata o storage disabilitato: si continua senza persistenza
    return false;
  }
}

export function clearLog(exam) {
  const ls = store();
  if (!ls) return false;
  try {
    ls.removeItem(historyKey(exam));
    return true;
  } catch (err) {
    return false;
  }
}

export function loadPrefs() {
  const ls = store();
  // `lessons` è per esame ({slug: ["01","17"]}): un array non vuoto è anche il
  // segnale che il filtro per lezione è acceso, quindi non serve un booleano
  // separato che potrebbe disallinearsi dalla selezione.
  const fallback = {
    exam: null, simTotal: SIM_TOTAL, mcqCount: SIM_TOTAL, cardCount: 0,
    cardMcq: true, lessons: {},
  };
  if (!ls) return fallback;
  try {
    const raw = ls.getItem(`${PREFIX}.prefs`);
    return raw ? Object.assign(fallback, JSON.parse(raw)) : fallback;
  } catch (err) {
    return fallback;
  }
}

export function savePrefs(prefs) {
  const ls = store();
  if (!ls) return false;
  try {
    ls.setItem(`${PREFIX}.prefs`, JSON.stringify(prefs));
    return true;
  } catch (err) {
    return false;
  }
}

/** Testo JSON da committare come `exams/<slug>/quiz-errori.json`. */
export function serializeLog(log) {
  return `${JSON.stringify(log, null, 2)}\n`;
}
