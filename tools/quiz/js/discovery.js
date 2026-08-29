// discovery.js — manifest degli esami, fetch dei .md del wiki, note di lezione,
// import automatico di quiz-errori.json.
//
// Tutti i percorsi sono risolti a partire da `import.meta.url`, quindi l'app
// funziona sia da http://localhost:8000/tools/quiz/ sia da un eventuale
// sottopercorso, e la pagina di smoke-test in test/ usa gli stessi URL.
//   import.meta.url = <base>/tools/quiz/js/discovery.js
//   ../../../       = <base>/            (root del repo)
//   ../             = <base>/tools/quiz/

import { parseQuiz } from './parse-quiz.js';
import { parseFlashcards } from './parse-flashcards.js';
import { normalizeLog } from './storage.js';

const REPO_ROOT = new URL('../../../', import.meta.url);
const APP_ROOT = new URL('../', import.meta.url);

/** URL assoluto di un percorso relativo alla root del repo. */
export function repoUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), REPO_ROOT).href;
}

/** URL assoluto di un percorso relativo a tools/quiz/. */
export function appUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), APP_ROOT).href;
}

async function fetchText(url) {
  try {
    // `Accept` esplicito e SENZA `text/html`: serve.py rende i .md impaginati
    // alle navigazioni del browser e grezzi a tutto il resto (vedi serve.py),
    // e per i browser che non mandano `Sec-Fetch-Dest` il ripiego guarda
    // proprio questo header. Il server ignora comunque `Accept` nella scelta
    // del file: il listing di notes/ continua ad arrivare come HTML.
    const res = await fetch(url, {
      cache: 'no-cache',
      headers: { Accept: 'text/markdown, application/json, text/plain' },
    });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err };
  }
}

/** Manifest tools/quiz/exams.json. */
export async function loadManifest() {
  const res = await fetchText(appUrl('exams.json'));
  if (!res.ok) throw new Error(`Impossibile leggere exams.json (HTTP ${res.status}).`);
  const data = JSON.parse(res.text);
  return Array.isArray(data.exams) ? data.exams : [];
}

/**
 * Carica e parsa i materiali di un esame.
 * @returns {{slug, quiz, flashcards, questions, cards, stub, warnings, errors}}
 */
export async function loadExam(entry) {
  const slug = typeof entry === 'string' ? entry : entry.slug;
  const base = `exams/${slug}/`;
  const errors = [];

  const [quizRes, cardsRes] = await Promise.all([
    fetchText(repoUrl(`${base}domande-esame.md`)),
    fetchText(repoUrl(`${base}flashcards.md`)),
  ]);

  if (!quizRes.ok) errors.push(`domande-esame.md non leggibile (HTTP ${quizRes.status})`);
  if (!cardsRes.ok) errors.push(`flashcards.md non leggibile (HTTP ${cardsRes.status})`);

  const quiz = parseQuiz(quizRes.text, { exam: slug });
  const flashcards = parseFlashcards(cardsRes.text, { exam: slug });

  return {
    slug,
    nome: (typeof entry === 'object' && entry.nome) || slug,
    entry: typeof entry === 'object' ? entry : { slug },
    quiz,
    flashcards,
    questions: quiz.questions,
    cards: flashcards.cards,
    stub: quiz.questions.length === 0 && flashcards.cards.length === 0,
    warnings: [...quiz.warnings, ...flashcards.warnings],
    errors,
  };
}

/**
 * Storico errori committato nel repo (`exams/<slug>/quiz-errori.json`).
 * 404 = silenzio: è un file opzionale.
 */
export async function fetchRemoteLog(slug) {
  const res = await fetchText(repoUrl(`exams/${slug}/quiz-errori.json`));
  if (!res.ok) return null;
  try {
    return normalizeLog(JSON.parse(res.text), slug);
  } catch (err) {
    return null;
  }
}

/**
 * Risolve i link alle note di lezione, in ordine di priorità:
 *  (a) chiave `notes` del manifest (vince su tutto);
 *  (b) parsing del listing di directory di http.server;
 *  (c) fallback: link alla directory notes/.
 * Non lancia mai: se tutto fallisce restituisce solo il fallback.
 */
export async function resolveNotes(entry) {
  const slug = typeof entry === 'string' ? entry : entry.slug;
  const dirUrl = repoUrl(`exams/${slug}/notes/`);
  const map = new Map();

  const manual = (typeof entry === 'object' && entry.notes) || null;
  if (manual) {
    for (const [lesson, file] of Object.entries(manual)) {
      map.set(String(lesson).padStart(2, '0'), new URL(file, dirUrl).href);
    }
  }

  const res = await fetchText(dirUrl);
  if (res.ok) {
    const re = /href="([^"]+)"/g;
    let m;
    while ((m = re.exec(res.text)) !== null) {
      const href = m[1];
      const name = decodeURIComponent(href.split('/').pop() || '');
      const num = name.match(/^(\d{2})-.*\.md$/);
      if (num && !map.has(num[1])) map.set(num[1], new URL(href, dirUrl).href);
    }
  }

  return {
    dirUrl,
    /** @param {string} lesson numero di lezione, es. "02" */
    urlFor(lesson) {
      const key = String(lesson || '').padStart(2, '0');
      return map.get(key) || dirUrl;
    },
    known: map,
  };
}

// Difetti sicuri: sono quelli del repo privato, dove il file non esiste.
const CONFIG_DEFAULT = { pubblico: false, wiki: true };

/**
 * Flag della build, iniettati da `tools/quiz/esporta-pubblico.mjs` in
 * `config-pubblico.json`. Nel repo privato quel file NON esiste: il 404 è la
 * condizione normale e non va segnalato in alcun modo.
 *
 *  - `pubblico`: build servita da GitHub Pages — service worker e footer
 *    donazioni si accendono solo qui.
 *  - `wiki`: i materiali del corso (note, README d'esame) sono raggiungibili.
 *    Falso in pubblico, dove è stato esportato il solo flashcards.md.
 *
 * Non si guarda l'hostname apposta: la build pubblica dev'essere provabile in
 * locale con un `http.server` qualsiasi.
 */
export async function loadConfig() {
  const res = await fetchText(appUrl('config-pubblico.json'));
  if (!res.ok) return { ...CONFIG_DEFAULT };
  try {
    const data = JSON.parse(res.text);
    return { pubblico: data.pubblico === true, wiki: data.wiki !== false };
  } catch (err) {
    return { ...CONFIG_DEFAULT };
  }
}
