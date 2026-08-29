// parse-quiz.js — da `exams/<slug>/domande-esame.md` a questions[].
//
// Modulo PURO: nessun riferimento a DOM/window, importabile da Node.
//
// Parser a righe, macchina a stati: mai regex multilinea sull'intero file.
// È tollerante per costruzione — tutto ciò che non matcha viene ignorato
// (prosa, tabelle «Punti a maggior rischio», commenti HTML, domande aperte
// `### D:`). Le anomalie finiscono in `warnings[]`: visibili nello smoke-test,
// silenziose in app.

import { stableHash } from './engine.js';

const MARK_OK = '✅';       // ✅ risposta corretta nel merito (slide)
const MARK_KO = '❌';       // ❌ chiave della piattaforma, difforme
const MARK_ALARM = '\u{1F6A8}'; // 🚨 avvertenza chiave piattaforma

const RE_LESSON = /^##\s+Lezione\s+(\d+)\s*[—–-]\s*(.*)$/;
const RE_QUIZ_SECTION = /^###\s+Quiz a risposta multipla\s*$/;
const RE_QUESTION = /^####\s+(\d+)\.\s*(.*)$/;
// L'eventuale `**` iniziale è quello che apre un grassetto che avvolge
// l'intera opzione (`- **C. ✅ testo**`): va ricordato per chiudere il conto.
const RE_OPTION = /^-\s+(\*\*)?\s*([A-Z])\.\s*(.*)$/;
const RE_LABEL = /^\*\*([^*]{1,120}):\*\*\s*(.*)$/;
const RE_PLATFORM_TAIL = /\s*[—–-]\s*\*?\s*indicata come corretta dalla piattaforma[^\n]*$/i;
const RE_HR = /^-{3,}\s*$/;
const RE_EMPTY_FILE = /_Ancora vuoto/;

// ---------------------------------------------------------------------------

/**
 * @param {string} text contenuto di domande-esame.md
 * @param {{exam?: string}} [opts]
 * @returns {{stub: boolean, exam: string, lessons: Array, questions: Array, warnings: Array}}
 */
export function parseQuiz(text, opts = {}) {
  const exam = opts.exam || '';
  const warnings = [];
  const questions = [];
  const lessons = [];
  const source = String(text || '');

  if (!source.trim() || RE_EMPTY_FILE.test(source)) {
    return { stub: true, exam, lessons, questions, warnings };
  }

  const lines = source.split(/\r?\n/);
  let lesson = null;
  let inQuiz = false;
  let block = null;

  const flush = () => {
    if (!block) return;
    const q = buildQuestion(block, exam, warnings);
    if (q) questions.push(q);
    block = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (/^####\s/.test(line)) {
      flush();
      if (!inQuiz || !lesson) continue;
      const m = line.match(RE_QUESTION);
      if (m) {
        block = { number: Number(m[1]), text: m[2].trim(), lines: [], lesson };
      }
      continue;
    }
    if (/^###\s/.test(line)) {
      flush();
      inQuiz = RE_QUIZ_SECTION.test(line);
      continue;
    }
    if (/^##\s/.test(line)) {
      flush();
      inQuiz = false;
      const m = line.match(RE_LESSON);
      if (m) {
        lesson = { number: m[1], title: m[2].trim(), sectionWarning: null, count: 0 };
        lessons.push(lesson);
      } else {
        lesson = null;
      }
      continue;
    }

    if (!inQuiz || !lesson) continue;

    if (block) {
      // Il blocco della domanda termina anche su una riga orizzontale.
      if (RE_HR.test(line)) { flush(); continue; }
      block.lines.push(line);
      continue;
    }

    // Testo introduttivo della sezione quiz: raccogliamo solo l'eventuale
    // blockquote 🚨 di lezione (avviso "chiave della piattaforma sbagliata").
    const trimmed = line.trim();
    if (trimmed.startsWith('>') && trimmed.includes(MARK_ALARM)) {
      const q = stripQuote(trimmed);
      lesson.sectionWarning = lesson.sectionWarning ? `${lesson.sectionWarning} ${q}` : q;
    }
  }
  flush();

  for (const q of questions) {
    const l = lessons.find((x) => x.number === q.lesson);
    if (l) l.count += 1;
  }

  return { stub: questions.length === 0, exam, lessons, questions, warnings };
}

// ---------------------------------------------------------------------------

function buildQuestion(block, exam, warnings) {
  const lessonNumber = block.lesson.number;
  const id = `${exam}/L${lessonNumber}/Q${block.number}`;
  const warn = (message) => warnings.push({ id, message });

  const options = [];
  const explanations = [];
  let sources = null;
  let warning = null;
  let current = null; // spiegazione in accumulo

  for (const raw of block.lines) {
    const line = raw.trim();

    if (line === '') { current = null; continue; }

    if (line.startsWith('>')) {
      current = null;
      const quoted = stripQuote(line);
      if (quoted.includes(MARK_ALARM)) {
        warning = warning ? `${warning} ${quoted}` : quoted;
      }
      continue;
    }

    const mo = line.match(RE_OPTION);
    if (mo) {
      current = null;
      options.push(makeOption(mo, line));
      continue;
    }

    const ml = line.match(RE_LABEL);
    if (ml) {
      const label = ml[1].trim();
      if (/^fonti$/i.test(label)) {
        sources = parseSources(ml[2].trim());
        current = null;
        continue;
      }
      current = { label, text: ml[2].trim() };
      explanations.push(current);
      continue;
    }

    // Continuazione del paragrafo di spiegazione in corso; il resto è prosa
    // non riconosciuta e viene ignorato di proposito.
    if (current) {
      current.text = current.text ? `${current.text} ${line}` : line;
    }
  }

  if (options.length < 2) {
    warn(`domanda con meno di 2 opzioni (${options.length}): scartata`);
    return null;
  }

  const keys = options.map((o) => o.key);
  if (new Set(keys).size !== keys.length) warn(`lettere di opzione duplicate: ${keys.join(', ')}`);

  const correctOnes = options.filter((o) => o.correct);
  if (correctOnes.length !== 1) {
    warn(`attese esattamente 1 opzione ${MARK_OK}, trovate ${correctOnes.length}`);
  }
  const correctKey = correctOnes.length ? correctOnes[0].key : null;

  const platformOnes = options.filter((o) => o.platformFlag);
  if (platformOnes.length > 1) {
    warn(`più di una opzione ${MARK_KO}: ${platformOnes.map((o) => o.key).join(', ')}`);
  }
  const platformKey = platformOnes.length ? platformOnes[0].key : null;
  if (platformKey && !warning) {
    warn(`opzione ${MARK_KO} senza blockquote ${MARK_ALARM} di avvertenza`);
  }

  if (!explanations.length) warn('nessuna spiegazione trovata');
  if (!sources) warn('nessun blocco **Fonti:** trovato');

  const contentHash = stableHash(
    [block.text, ...options.map((o) => `${o.key}|${o.text}`)].join(''),
  );

  return {
    id,
    exam,
    lesson: lessonNumber,
    lessonTitle: block.lesson.title,
    number: block.number,
    text: block.text,
    options,
    correctKey,
    platformKey,
    platformMismatch: !!platformKey && platformKey !== correctKey,
    warning,
    lessonWarning: block.lesson.sectionWarning || null,
    explanations,
    sources,
    contentHash,
  };
}

/**
 * Costruisce un'opzione a partire dal match di RE_OPTION.
 * Il testo conserva il markdown interno (il grassetto evidenzia le parole
 * trappola: va renderizzato, non strippato); viene rimosso solo il grassetto
 * ESTERNO che avvolge l'intera opzione, e solo se bilanciato.
 */
function makeOption(match, fullLine) {
  const hadOpenBold = !!match[1];
  const key = match[2];
  let text = match[3];

  const correct = fullLine.includes(MARK_OK);
  const platformFlag = fullLine.includes(MARK_KO);

  text = text.split(MARK_OK).join(' ').split(MARK_KO).join(' ');
  text = text.replace(RE_PLATFORM_TAIL, '');
  text = text.replace(/\s+/g, ' ').trim();

  // Il `**` di apertura è stato consumato dal prefisso `- **A. `: se la riga
  // finisce con `**` quel chiusura è la sua, va tolta.
  if (hadOpenBold && text.endsWith('**')) text = text.slice(0, -2).trim();

  text = dewrapBold(text);
  return { key, text, correct, platformFlag };
}

/** Toglie `**…**` che avvolge tutto il testo, solo se non ne contiene altri. */
function dewrapBold(s) {
  if (s.length > 4 && s.startsWith('**') && s.endsWith('**')) {
    const inner = s.slice(2, -2);
    if (!inner.includes('**')) return inner.trim();
  }
  return s;
}

function stripQuote(line) {
  return line.replace(/^>\s?/, '').trim();
}

/** Best-effort su `lezione NN, slide NN–NN (…)`. */
function parseSources(raw) {
  const lesson = (raw.match(/lezione\s+(\d+)/i) || [])[1] || null;
  const slidesMatch = raw.match(/slide\s+([0-9][0-9\s,–—-]*)/i);
  const slides = slidesMatch ? slidesMatch[1].replace(/[\s,]+$/, '').trim() : null;
  return { raw, lesson, slides };
}
