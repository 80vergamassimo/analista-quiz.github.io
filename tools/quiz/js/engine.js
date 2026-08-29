// engine.js — campionamento, shuffle, scoring, pesi di ripasso.
//
// Modulo PURO: nessun riferimento a DOM/window, importabile da Node.
// Tutte le funzioni che usano casualità accettano un `rng` iniettabile
// (default Math.random) così da essere testabili in modo deterministico.

/** Hash stabile a 32 bit (FNV-1a) in base36. Usato per id e contentHash. */
export function stableHash(input) {
  const s = String(input === null || input === undefined ? '' : input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** PRNG deterministico (mulberry32) — utile nei test. */
export function makeRng(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates, non distruttivo. */
export function shuffle(list, rng = Math.random) {
  const out = Array.from(list || []);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Estrae al massimo `n` elementi distinti, in ordine casuale. */
export function sample(list, n, rng = Math.random) {
  const arr = Array.from(list || []);
  const k = Math.max(0, Math.min(Number(n) || 0, arr.length));
  return shuffle(arr, rng).slice(0, k);
}

// ---------------------------------------------------------------------------
// Selezione delle lezioni
// ---------------------------------------------------------------------------

/**
 * Quante lezioni al massimo si possono selezionare in una sola prova. Il
 * filtro serve a ripassare il blocco appena studiato: oltre una manciata di
 * lezioni tanto vale non filtrare affatto.
 */
export const MAX_LESSONS = 6;

/**
 * Elenco delle lezioni selezionabili, ricavato DAGLI ITEM e non da
 * `exam.quiz.lessons`: così ogni voce mostrata contiene davvero qualcosa da
 * pescare e i conteggi coincidono con ciò che finisce nella prova. Una lezione
 * con sole flashcard (nessun quiz) compare comunque, con `mcq: 0`.
 *
 * `number` è la stringa zero-padded dei file (`"01"`, `"16"`), quindi
 * l'ordinamento alfabetico è già quello giusto.
 *
 * @returns {Array<{number:string, title:string, mcq:number, cards:number}>}
 */
export function lessonPool(questions, cards) {
  const byNumber = new Map();
  const add = (item, field) => {
    if (!item || !item.lesson) return;
    const key = String(item.lesson);
    let entry = byNumber.get(key);
    if (!entry) {
      entry = { number: key, title: item.lessonTitle || '', mcq: 0, cards: 0 };
      byNumber.set(key, entry);
    }
    // Il titolo si prende dal primo item che ne porta uno: le due sorgenti
    // (domande e flashcard) hanno la stessa intestazione di lezione, ma un
    // file potrebbe averla vuota.
    if (!entry.title && item.lessonTitle) entry.title = item.lessonTitle;
    entry[field] += 1;
  };
  for (const q of questions || []) add(q, 'mcq');
  for (const c of cards || []) add(c, 'cards');
  return Array.from(byNumber.values()).sort((a, b) => a.number.localeCompare(b.number));
}

/**
 * Filtra gli item sulle lezioni scelte. Lista vuota o assente = nessun filtro,
 * quindi `items` invariato: è lo stato di default della schermata.
 *
 * Il confronto è fra STRINGHE, perché `lesson` è il numero zero-padded così
 * com'è scritto nel markdown ("05"): confrontarlo con un numero non
 * troverebbe nulla.
 */
export function filterByLessons(items, lessons) {
  const wanted = (lessons || []).map(String);
  if (!wanted.length) return Array.from(items || []);
  const set = new Set(wanted);
  return (items || []).filter((it) => it && set.has(String(it.lesson)));
}

// ---------------------------------------------------------------------------
// Ripartizione a totale fisso della simulazione
// ---------------------------------------------------------------------------

/**
 * Numero di item (MCQ + flashcard) di una simulazione **per default**: è il
 * valore con cui parte la schermata di configurazione, dove un cursore lo può
 * portare da 1 al numero di item disponibili. Resta l'unico punto da toccare
 * per cambiare la lunghezza predefinita della prova.
 */
export const SIM_TOTAL = 30;

function toCount(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(toCount(v), hi));
}

/**
 * Ripartizione COMPLEMENTARE fra domande a risposta multipla e flashcard, a
 * totale fisso: i due contatori non sono indipendenti, uno è il complemento
 * dell'altro rispetto al totale effettivo.
 *
 *   totale effettivo = min(total, mcqDisponibili + cardsDisponibili)
 *   mcq ∈ [max(0, totale − cardsDisp), min(mcqDisp, totale)]   (e simmetrico)
 *
 * Se i materiali non bastano il totale scende e `insufficient` diventa true.
 *
 * @param {number} mcqAvailable  domande disponibili per l'esame
 * @param {number} cardsAvailable flashcard disponibili per l'esame
 * @param {null|{type:'mcq'|'cards', value:number}} lead
 *        controllo mosso dall'utente (o valore da ripristinare dalle prefs);
 *        `null` = stato di default (più MCQ possibile, resto in flashcard).
 * @param {number} [total=SIM_TOTAL] totale nominale
 * @returns {{total:number, target:number, insufficient:boolean, mcq:number,
 *            cards:number, mcqMin:number, mcqMax:number, cardMin:number,
 *            cardMax:number, mcqAvailable:number, cardsAvailable:number}}
 */
export function planSimCounts(mcqAvailable, cardsAvailable, lead = null, total = SIM_TOTAL) {
  const availMcq = toCount(mcqAvailable);
  const availCards = toCount(cardsAvailable);
  const target = toCount(total);
  const effective = Math.min(target, availMcq + availCards);

  const mcqMin = Math.max(0, effective - availCards);
  const mcqMax = Math.min(availMcq, effective);
  const cardMin = Math.max(0, effective - availMcq);
  const cardMax = Math.min(availCards, effective);

  let mcq;
  if (lead && lead.type === 'cards') {
    mcq = effective - clampInt(lead.value, cardMin, cardMax);
  } else if (lead && lead.type === 'mcq') {
    mcq = clampInt(lead.value, mcqMin, mcqMax);
  } else {
    // default: quante più MCQ possibile, il resto completato con le flashcard
    mcq = clampInt(target, mcqMin, mcqMax);
  }

  return {
    total: effective,
    target,
    insufficient: effective < target,
    mcq,
    cards: effective - mcq,
    mcqMin,
    mcqMax,
    cardMin,
    cardMax,
    mcqAvailable: availMcq,
    cardsAvailable: availCards,
  };
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * Prepara gli item MCQ di una sessione: domande in ordine casuale e opzioni
 * rimescolate con le lettere ricalcolate. La chiave originale resta sempre
 * accessibile via `origKey`, quindi la correzione non dipende dal rimescolamento.
 *
 * @returns {Array<{question, options: Array<{key,origKey,text}>}>}
 */
export function prepareMcqItems(questions, n, rng = Math.random) {
  return sample(questions, n, rng).map((question) => ({
    question,
    options: shuffle(question.options, rng).map((opt, i) => ({
      key: LETTERS[i] || String(i + 1),
      origKey: opt.key,
      text: opt.text,
    })),
  }));
}

/**
 * Le flashcard con almeno due distrattori curati si giocano a risposta
 * multipla; le altre restano ad autovalutazione.
 */
export function cardHasMcq(card) {
  const n = (card && card.distractors ? card.distractors.length : 0);
  return n >= 2;
}

/**
 * Vista question-like di una flashcard, così che tutta la macchina MCQ già
 * scritta (rimescolamento, `origKey`, `scoreMcq`) valga anche per le card.
 * La chiave corretta è sempre `A` **nel file**; a schermo diventa un'altra
 * lettera dopo il rimescolamento.
 *
 * Le card non hanno una chiave della piattaforma: `platformKey` resta assente,
 * e in `scoreMcq` il fallback `platformKey || correctKey` (più sotto) rende
 * `platformCorrect === correct` e `hasPlatformMismatch === false`. Il 🚨 di una
 * flashcard segnala un contenuto insidioso, non una chiave difforme.
 */
export function cardToMcq(card) {
  return {
    id: card.id,
    kind: 'card',
    lesson: card.lesson,
    lessonTitle: card.lessonTitle,
    risk: card.risk,
    text: card.question,
    answer: card.answer,
    card,
    options: [
      { key: 'A', text: card.optionText || card.answer, correct: true },
      ...card.distractors.map((text, i) => ({ key: LETTERS[i + 1], text, correct: false })),
    ],
    correctKey: 'A',
    contentHash: card.contentHash,
  };
}

/**
 * Prepara UNA card per volta: `prepareMcqItems` campiona al proprio interno,
 * quindi passargli l'intera lista ne rimescolerebbe l'ordine e disallineerebbe
 * gli item dalle card già campionate. Con n = 1 il campionamento è l'identità e
 * resta solo il rimescolamento delle opzioni.
 *
 * @returns {object|null} null se la card non ha distrattori: resta ad autovalutazione.
 */
export function prepareCardItem(card, rng = Math.random) {
  if (!cardHasMcq(card)) return null;
  return prepareMcqItems([cardToMcq(card)], 1, rng)[0];
}

/** Da lettera mostrata a lettera originale del file. */
export function toOriginalKey(item, displayKey) {
  if (!item || !displayKey) return null;
  const found = (item.options || []).find((o) => o.key === displayKey);
  return found ? found.origKey : null;
}

/**
 * Corregge un blocco MCQ.
 * `answers` è una mappa id -> lettera MOSTRATA (o null se in bianco).
 * Restituisce il dettaglio per domanda più i due punteggi: quello **nel merito**
 * (chiave ✅ delle slide) e quello **secondo la chiave della piattaforma**.
 */
export function scoreMcq(items, answers) {
  const detail = (items || []).map((item) => {
    const q = item.question;
    const displayKey = (answers && answers[q.id]) || null;
    const givenKey = toOriginalKey(item, displayKey);
    const platformKey = q.platformKey || q.correctKey;
    return {
      id: q.id,
      question: q,
      item,
      displayKey,
      givenKey,
      answered: !!givenKey,
      correct: !!givenKey && givenKey === q.correctKey,
      platformCorrect: !!givenKey && givenKey === platformKey,
    };
  });
  return {
    detail,
    total: detail.length,
    correct: detail.filter((d) => d.correct).length,
    platformCorrect: detail.filter((d) => d.platformCorrect).length,
    blank: detail.filter((d) => !d.answered).length,
    hasPlatformMismatch: detail.some((d) => d.question.platformMismatch),
  };
}

// ---------------------------------------------------------------------------
// Pesi per la modalità "Ripassa errori"
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

/** Peso di default per una domanda mai vista. */
export const WEIGHT_UNSEEN = 0.35;

/**
 * peso = wrong/seen + 1.0·(lastResult == errata) + exp(−giorni/14) − 0.5·min(streakCorrect,2)
 * Le domande mai viste (stat assente) valgono WEIGHT_UNSEEN.
 */
export function reviewWeight(stat, now = Date.now()) {
  if (!stat || !stat.seen) return WEIGHT_UNSEEN;
  const ratio = (stat.wrong || 0) / stat.seen;
  const lastWrongBonus = stat.lastResult === 'errata' ? 1 : 0;
  let recency = 0;
  if (stat.lastWrongAt) {
    const t = Date.parse(stat.lastWrongAt);
    if (!Number.isNaN(t)) {
      const days = Math.max(0, (now - t) / DAY_MS);
      recency = Math.exp(-days / 14);
    }
  }
  const streakPenalty = 0.5 * Math.min(stat.streakCorrect || 0, 2);
  return ratio + lastWrongBonus + recency - streakPenalty;
}

/**
 * Ordina gli item per peso decrescente (a parità di peso, ordine stabile).
 * Vale per le domande a risposta multipla e per le flashcard indifferentemente:
 * l'unica cosa che serve è `.id` e la mappa dello storico.
 * @returns {Array<{item, weight}>}
 */
export function rankForReview(items, perQuestion = {}, now = Date.now()) {
  return (items || [])
    .map((item, index) => ({
      item,
      weight: reviewWeight(perQuestion[item.id], now),
      index,
    }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map(({ item, weight }) => ({ item, weight }));
}

/** Campionamento pesato senza reinserimento (roulette wheel). */
export function pickWeighted(entries, n, rng = Math.random) {
  const pool = (entries || []).map((e) => ({
    item: e.item,
    weight: Math.max(0.01, Number(e.weight) || 0),
  }));
  const k = Math.max(0, Math.min(Number(n) || 0, pool.length));
  const out = [];
  for (let i = 0; i < k; i++) {
    const total = pool.reduce((acc, e) => acc + e.weight, 0);
    let r = rng() * total;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].weight;
      if (r <= 0) { idx = j; break; }
    }
    out.push(pool[idx].item);
    pool.splice(idx, 1);
  }
  return out;
}

/**
 * Pool della modalità ripasso: prima gli item con wrong > 0 (pesati), poi, se
 * non bastano, gli altri pescati a caso. Si applica sia alle domande sia alle
 * flashcard: lo storico registra `correct` per entrambe.
 */
export function pickReviewItems(items, perQuestion = {}, n, rng = Math.random) {
  const wrongOnes = [];
  const rest = [];
  for (const q of items || []) {
    const stat = perQuestion[q.id];
    if (stat && (stat.wrong || 0) > 0) wrongOnes.push(q);
    else rest.push(q);
  }
  const ranked = rankForReview(wrongOnes, perQuestion, Date.now());
  const picked = pickWeighted(ranked, n, rng);
  if (picked.length < n) {
    picked.push(...sample(rest, n - picked.length, rng));
  }
  return picked;
}

/** Quanti item sono attualmente "da ripassare". */
export function countReviewable(items, perQuestion = {}) {
  return (items || []).filter((q) => {
    const s = perQuestion[q.id];
    return s && (s.wrong || 0) > 0;
  }).length;
}
