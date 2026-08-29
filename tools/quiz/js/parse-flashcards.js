// parse-flashcards.js — da `exams/<slug>/flashcards.md` a cards[].
//
// Modulo PURO: nessun riferimento a DOM/window, importabile da Node.
//
// Coppie `**D:**` / `**R:**` con continuazioni multilinea, raggruppate per
// `## Lezione NN — Titolo`. Il marcatore di rischio a inizio domanda è
// ⚠️ (U+26A0 con il selettore di variazione U+FE0F **opzionale**) oppure 🚨.
//
// In coda alla card possono comparire due blocchi facoltativi che la rendono
// giocabile a risposta multipla:
//
//   **Opzione:** forma condensata della risposta, usata SOLO come testo
//                dell'opzione corretta (la `**R:**` resta il materiale di
//                studio e continua a comparire nel riepilogo).
//   **Distrattori:**
//   - due o tre opzioni sbagliate
//
// Nessuno dei due entra nell'`id` né nel `contentHash`: aggiungerli a una card
// esistente non deve orfanare lo storico degli errori.

import { stableHash } from './engine.js';

const RE_LESSON = /^##\s+Lezione\s+(\d+)\s*[—–-]\s*(.*)$/;
const RE_QUIZ_SUBSECTION = /^###\s+Flashcard dai quiz/i;
const RE_D = /^\*\*D:\*\*\s*(.*)$/;
const RE_R = /^\*\*R:\*\*\s*(.*)$/;
const RE_OPZIONE = /^\*\*Opzione:\*\*\s*(.*)$/;
const RE_DISTRATTORI = /^\*\*Distrattori:\*\*\s*(.*)$/;
const RE_BULLET = /^[-*]\s+(.*)$/;
// ⚠ + variation selector opzionale, oppure 🚨
const RE_RISK = /^(\u26A0\uFE0F?|\u{1F6A8})\s*/u;
const RE_EMPTY_FILE = /_Ancora vuoto/;

/** Numero di distrattori che rende una card giocabile a risposta multipla. */
export const MIN_DISTRACTORS = 2;
export const MAX_DISTRACTORS = 3;

/**
 * @param {string} text contenuto di flashcards.md
 * @param {{exam?: string}} [opts]
 * @returns {{stub: boolean, exam: string, lessons: Array, cards: Array, warnings: Array}}
 */
export function parseFlashcards(text, opts = {}) {
  const exam = opts.exam || '';
  const warnings = [];
  const cards = [];
  const lessons = [];
  const source = String(text || '');

  if (!source.trim() || RE_EMPTY_FILE.test(source)) {
    return { stub: true, exam, lessons, cards, warnings };
  }

  const lines = source.split(/\r?\n/);
  let lesson = null;
  let fromQuizSection = false;
  let pending = null; // {qLines, aLines, oLines, dLines, state}
  const seenIds = new Set();

  const flush = () => {
    if (!pending) return;
    const card = buildCard(pending, lesson, fromQuizSection, exam, warnings, seenIds);
    if (card) cards.push(card);
    pending = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (/^#{1,6}\s/.test(trimmed)) {
      flush();
      if (/^###\s/.test(trimmed)) {
        fromQuizSection = RE_QUIZ_SUBSECTION.test(trimmed);
        continue;
      }
      if (/^##\s/.test(trimmed)) {
        fromQuizSection = false;
        const m = trimmed.match(RE_LESSON);
        if (m) {
          lesson = { number: m[1], title: m[2].trim(), count: 0 };
          lessons.push(lesson);
        } else {
          lesson = null;
        }
      }
      continue;
    }

    if (trimmed === '') {
      if (pending && pending.state !== 'q') flush();
      continue;
    }

    const md = trimmed.match(RE_D);
    if (md) {
      flush();
      pending = { qLines: [md[1].trim()], aLines: [], oLines: [], dLines: [], state: 'q' };
      continue;
    }

    const mr = trimmed.match(RE_R);
    if (mr) {
      if (!pending) {
        warnings.push({ message: 'riga **R:** senza **D:** che la preceda' });
        continue;
      }
      pending.state = 'a';
      pending.aLines.push(mr[1].trim());
      continue;
    }

    // I due blocchi facoltativi vanno riconosciuti PRIMA del ramo prosa in
    // fondo al ciclo: quello accoda qualunque riga alla risposta, e una
    // risposta allungata cambierebbe il `contentHash` della card.
    const mo = trimmed.match(RE_OPZIONE);
    if (mo) {
      if (!pending || pending.state === 'q') {
        warnings.push({ message: `blocco **Opzione:** orfano (nessuna **R:** che lo preceda): "${truncate(trimmed)}"` });
        continue;
      }
      pending.state = 'o';
      pending.oLines.push(mo[1].trim());
      continue;
    }

    const mdis = trimmed.match(RE_DISTRATTORI);
    if (mdis) {
      // Senza questa guardia una riga vuota prima del blocco lo farebbe
      // sparire in silenzio nel ramo prosa. Simmetrica a «**R:** senza **D:**».
      if (!pending || pending.state === 'q') {
        warnings.push({ message: 'blocco **Distrattori:** orfano (nessuna **R:** che lo preceda)' });
        continue;
      }
      if (mdis[1].trim()) {
        warnings.push({ message: `**Distrattori:** deve stare da solo sulla riga, i distrattori vanno in elenco: "${truncate(trimmed)}"` });
      }
      pending.state = 'x';
      continue;
    }

    if (pending) {
      if (pending.state === 'x') {
        const mb = trimmed.match(RE_BULLET);
        if (mb) pending.dLines.push([mb[1].trim()]);
        else if (pending.dLines.length) pending.dLines[pending.dLines.length - 1].push(trimmed);
        else warnings.push({ message: `riga fra **Distrattori:** e il primo elenco: "${truncate(trimmed)}"` });
      } else if (pending.state === 'o') {
        pending.oLines.push(trimmed);
      } else if (pending.state === 'a') {
        pending.aLines.push(trimmed);
      } else {
        pending.qLines.push(trimmed);
      }
    }
    // Altrimenti: prosa/commenti — ignorati di proposito.
  }
  flush();

  for (const c of cards) {
    const l = lessons.find((x) => x.number === c.lesson);
    if (l) l.count += 1;
  }

  return { stub: cards.length === 0, exam, lessons, cards, warnings };
}

// ---------------------------------------------------------------------------

function buildCard(pending, lesson, fromQuizSection, exam, warnings, seenIds) {
  const questionRaw = pending.qLines.join(' ').replace(/\s+/g, ' ').trim();
  const answer = pending.aLines.join(' ').replace(/\s+/g, ' ').trim();

  if (!questionRaw) return null;
  if (!answer) {
    warnings.push({ message: `flashcard senza risposta: "${truncate(questionRaw)}"` });
    return null;
  }
  if (!lesson) {
    warnings.push({ message: `flashcard fuori da una lezione: "${truncate(questionRaw)}"` });
    return null;
  }

  let risk = null;
  const mRisk = questionRaw.match(RE_RISK);
  if (mRisk) risk = mRisk[1].startsWith('\u26A0') ? 'warn' : 'alarm';
  const question = questionRaw.replace(RE_RISK, '').trim();

  const key = normalizeForId(question);
  let id = `${exam}/L${lesson.number}/f-${stableHash(key)}`;
  if (seenIds.has(id)) {
    warnings.push({ message: `flashcard duplicata nella lezione ${lesson.number}: "${truncate(question)}"` });
    let n = 2;
    while (seenIds.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  seenIds.add(id);

  const optionText = pending.oLines.join(' ').replace(/\s+/g, ' ').trim() || answer;
  const distractors = validateDistractors(
    pending.dLines.map((d) => d.join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean),
    { optionText, question, hasOption: pending.oLines.length > 0, warnings },
  );

  return {
    id,
    exam,
    lesson: lesson.number,
    lessonTitle: lesson.title,
    risk,
    question,
    answer,
    // Testo dell'opzione corretta a risposta multipla. Quando la risposta è
    // discorsiva o commenta i distrattori d'esame, `**Opzione:**` ne dà la
    // forma condensata; la risposta integrale resta in `answer`.
    optionText,
    distractors,
    fromQuizSection: !!fromQuizSection,
    // NON include opzione e distrattori: aggiungerli a una card già in
    // archivio non deve farla risultare "cambiata" nello storico errori.
    contentHash: stableHash(`${key}||${normalizeForId(answer)}`),
  };
}

/**
 * Un blocco malformato viene scartato per intero e la card torna ad
 * autovalutazione. Lo smoke test pretende zero warning sui file reali, quindi
 * ogni scarto è un fallimento di CI e non un degrado silenzioso.
 */
function validateDistractors(list, { optionText, question, hasOption, warnings }) {
  if (!list.length) {
    if (hasOption) {
      warnings.push({ message: `**Opzione:** senza **Distrattori:**: "${truncate(question)}"` });
    }
    return [];
  }
  if (list.length < MIN_DISTRACTORS || list.length > MAX_DISTRACTORS) {
    warnings.push({
      message: `la flashcard "${truncate(question)}" ha ${list.length} distrattor${list.length === 1 ? 'e' : 'i'}: ne servono ${MIN_DISTRACTORS} o ${MAX_DISTRACTORS}`,
    });
    return [];
  }
  const seen = new Set([normalizeForId(optionText)]);
  for (const d of list) {
    const norm = normalizeForId(d);
    if (seen.has(norm)) {
      warnings.push({ message: `distrattore ripetuto o uguale alla risposta in "${truncate(question)}": "${truncate(d)}"` });
      return [];
    }
    seen.add(norm);
  }
  return list;
}

function normalizeForId(s) {
  return String(s)
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function truncate(s, n = 60) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
