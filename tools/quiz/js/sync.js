// sync.js — storico condiviso con l'archivio del server (serve.py --data-dir).
//
// È una capacità OPZIONALE: se il server non la espone — sviluppo locale con
// `python3 -m http.server`, o il container senza `--data-dir` — l'app resta
// esattamente quella di prima, con lo storico nel solo localStorage. Per
// questo nessuna funzione qui lancia mai: ogni errore diventa `null`, come già
// fa fetchRemoteLog() con il 404 di quiz-errori.json.
//
// Il server unisce per `uid` e non sovrascrive mai, quindi non serve alcun
// leggi-modifica-scrivi lato client e i POST sono ripetibili senza danno.

import { repoUrl } from './discovery.js';
import { normalizeLog } from './storage.js';

// Senza timeout un server che non risponde bloccherebbe il Promise.all di
// selectExam(), lasciando l'app ferma su «caricamento» invece di degradare.
const TIMEOUT_MS = 8000;

async function api(path, init = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetch(repoUrl(path), {
      cache: 'no-cache',
      signal: ctrl ? ctrl.signal : undefined,
      ...init,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const historyPath = (slug) => `api/history/${encodeURIComponent(slug)}`;

/** `{ user }` se il server archivia lo storico, `null` se la capacità non c'è. */
export async function probe() {
  const data = await api('api/health');
  return data && data.sync === true ? { user: String(data.user || '') } : null;
}

/** Storico archiviato per l'esame, o null. */
export async function fetchServerLog(slug) {
  const data = await api(historyPath(slug));
  return data ? normalizeLog(data, slug) : null;
}

/** Invia sessioni all'archivio e restituisce l'unione risultante, o null. */
export async function pushSessions(slug, sessions) {
  if (!slug || !sessions || !sessions.length) return null;
  const data = await api(historyPath(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });
  return data ? normalizeLog(data, slug) : null;
}

/**
 * Sessioni presenti in `log` ma non ancora nell'archivio.
 * Puro, così il caso «non c'è niente da mandare» si vede senza rete: è quello
 * normale a ogni cambio esame, e mandare l'intero storico ogni volta sarebbe
 * corretto (il server unisce) ma inutilmente costoso.
 */
export function sessionsToPush(log, serverLog) {
  const known = new Set((((serverLog && serverLog.sessions) || [])).map((s) => s.uid));
  return ((log && log.sessions) || []).filter((s) => !known.has(s.uid));
}
