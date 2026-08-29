// app.js — entry point e macchina a stati delle schermate.
//
// Config → Quiz → Riepilogo. "Ripassa errori" rientra nel flusso Quiz.
// Nessun handler inline: tutti i listener sono registrati qui o nelle schermate.

import { loadManifest, loadExam, resolveNotes, fetchRemoteLog, loadConfig, appUrl, repoUrl } from './discovery.js';
import { probe, fetchServerLog, pushSessions, sessionsToPush } from './sync.js';
import * as storage from './storage.js';
import {
  prepareMcqItems, sample, scoreMcq, pickReviewItems, makeRng,
  prepareCardItem, toOriginalKey, filterByLessons,
} from './engine.js';
import { renderConfig } from './screens/config.js';
import { renderQuiz } from './screens/quiz.js';
import { renderResults } from './screens/results.js';

const root = document.getElementById('screen');
const toastEl = document.getElementById('toast');
// Il sottotitolo dell'intestazione porta il nome dell'esame in corso: è fuori
// da <main>, quindi sopravvive al cambio di schermata (config → quiz →
// riepilogo, che ricostruiscono l'intero contenuto di #screen). Il testo di
// partenza scritto in index.html resta il fallback.
const subtitleEl = document.getElementById('app-subtitle');
const SUBTITLE_DEFAULT = subtitleEl ? subtitleEl.textContent : '';
const TITLE_DEFAULT = document.title;

const state = {
  screen: 'config',
  manifest: [],
  slug: null,
  exam: null,
  notes: null,
  log: storage.emptyLog(''),
  prefs: storage.loadPrefs(),
  session: null,
  results: null,
  loading: true,
  remoteMerged: false,
  // null finché non si sa, poi `{ user }` se il server archivia lo storico o
  // `false` se la capacità non c'è (e allora nulla di sync appare a schermo).
  sync: null,
  // Flag della build, da config-pubblico.json (assente nel repo privato).
  // I difetti sono quelli privati, così qualunque render prima del boot è
  // già quello giusto qui.
  config: { pubblico: false, wiki: true },
};

let keyHandler = null;
let toastTimer = null;

// ---------------------------------------------------------------------------

const ctx = {
  state,
  goTo(screen) { state.screen = screen; render(); },
  rerender() { render(); },
  setKeys(fn) { keyHandler = fn; },
  toast,
  selectExam,
  startSession,
  submitMcq,
  answerCard,
  chooseCardMcq,
  answerCardMcq,
  advanceCard,
  abortSession,
  exportLog,
  exportBackup,
  importFile,
  resetLog,
  noteUrlFor(lesson) {
    // Build pubblica: le note non sono state esportate, il link sarebbe un 404.
    if (!state.config.wiki) return null;
    return state.notes ? state.notes.urlFor(lesson) : null;
  },
  riskCardsForLesson(lesson, limit = 6) {
    if (!state.exam) return [];
    return state.exam.cards
      .filter((c) => c.lesson === lesson && c.risk)
      .slice(0, limit);
  },
};

let lastScreen = null;

/**
 * Nome dell'esame nell'intestazione e nel titolo della scheda. Durante il
 * caricamento `state.exam` è ancora null: si ripiega sul nome di manifest,
 * altrimenti il sottotitolo tornerebbe al testo generico a ogni cambio esame.
 * Si scrive solo quando il testo cambia davvero: `render()` gira a ogni
 * risposta selezionata e alcuni screen reader annunciano il titolo.
 */
function syncHeader() {
  if (!subtitleEl) return;
  const entry = state.manifest.find((e) => e.slug === state.slug);
  const nome = (state.exam && state.exam.nome) || (entry && entry.nome) || '';
  const subtitle = nome || SUBTITLE_DEFAULT;
  if (subtitleEl.textContent !== subtitle) subtitleEl.textContent = subtitle;
  subtitleEl.classList.toggle('is-exam', !!nome);
  const title = nome ? `${nome} — Simulatore d'esame` : TITLE_DEFAULT;
  if (document.title !== title) document.title = title;
}

function render() {
  keyHandler = null;
  syncHeader();
  const screens = { config: renderConfig, quiz: renderQuiz, results: renderResults };
  (screens[state.screen] || renderConfig)(root, ctx);
  // Si risale in cima solo al cambio di schermata: rerender-are per una
  // risposta selezionata non deve far saltare la pagina.
  if (lastScreen !== state.screen) {
    lastScreen = state.screen;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

function toast(message, kind = 'info') {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `toast toast-${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

document.addEventListener('keydown', (ev) => {
  if (!keyHandler) return;
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  keyHandler(ev);
});

// ---------------------------------------------------------------------------
// Selezione esame
// ---------------------------------------------------------------------------

async function selectExam(slug) {
  state.slug = slug;
  state.exam = null;
  state.notes = null;
  state.loading = true;
  state.remoteMerged = false;
  state.prefs.exam = slug;
  storage.savePrefs(state.prefs);
  render();

  const entry = state.manifest.find((e) => e.slug === slug) || { slug };
  try {
    const [exam, notes, remote, server] = await Promise.all([
      loadExam(entry),
      state.config.wiki ? resolveNotes(entry).catch(() => null) : Promise.resolve(null),
      fetchRemoteLog(slug).catch(() => null),
      state.sync ? fetchServerLog(slug) : Promise.resolve(null),
    ]);
    state.exam = exam;
    state.notes = notes;

    // Tre sorgenti: localStorage, il quiz-errori.json committato nel wiki e
    // l'archivio del server. mergeLogs è idempotente e unisce per uid, quindi
    // l'ordine non cambia il risultato.
    let log = storage.loadLog(slug);
    const before = log.sessions.length;
    if (remote) { log = storage.mergeLogs(log, remote); state.remoteMerged = true; }
    if (server) { log = storage.mergeLogs(log, server); }
    if (log.sessions.length !== before) storage.saveLog(slug, log);
    state.log = log;

    // Il traffico va anche nell'altro verso: ciò che sta solo qui (sessioni
    // svolte prima che la sincronizzazione esistesse, o arrivate da git) viene
    // caricato una volta sola. Fire-and-forget: il dato locale è già salvo.
    if (state.sync) {
      const missing = sessionsToPush(log, server);
      if (missing.length) pushSessions(slug, missing);
    }

    if (exam.errors.length) toast(exam.errors.join(' · '), 'error');
  } catch (err) {
    toast(`Errore nel caricamento di ${slug}: ${err.message}`, 'error');
  } finally {
    state.loading = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Sessione
// ---------------------------------------------------------------------------

function startSession({ mode, mcqCount, cardCount, simTotal, cardMcq, lessons }) {
  const exam = state.exam;
  if (!exam) return;

  state.prefs.mcqCount = mcqCount;
  state.prefs.cardCount = cardCount;
  // Selezione delle lezioni: per esame, perché i numeri di lezione di un esame
  // non vogliono dire nulla in un altro. Array vuoto = filtro spento.
  const picked = Array.isArray(lessons) ? lessons.map(String) : [];
  if (!state.prefs.lessons || typeof state.prefs.lessons !== 'object') state.prefs.lessons = {};
  state.prefs.lessons[exam.slug] = picked;
  // Senza la guardia, un `simTotal` assente scriverebbe `undefined`, che
  // JSON.stringify scarta: al ricaricamento la lunghezza scelta tornerebbe
  // silenziosamente al default.
  if (Number.isFinite(simTotal)) state.prefs.simTotal = simTotal;
  if (typeof cardMcq === 'boolean') state.prefs.cardMcq = cardMcq;
  storage.savePrefs(state.prefs);

  const rng = Math.random;
  // Il filtro per lezione si applica PRIMA del campionamento e vale anche per
  // il ripasso: chi ripassa un blocco di lezioni non vuole rivedere gli errori
  // di tutto il corso.
  const poolQuestions = filterByLessons(exam.questions, picked);
  const poolCards = filterByLessons(exam.cards, picked);
  // In ripasso entrambi i pool sono pesati sugli errori: lo storico registra
  // `correct` anche per le flashcard, e ignorarlo significava buttare via
  // metà di ciò che l'utente aveva sbagliato.
  const questions = mode === 'review'
    ? pickReviewItems(poolQuestions, state.log.perQuestion, mcqCount, rng)
    : sample(poolQuestions, mcqCount, rng);
  const mcqItems = prepareMcqItems(questions, questions.length, rng);
  const cards = mode === 'review'
    ? pickReviewItems(poolCards, state.log.perQuestion, cardCount, rng)
    : sample(poolCards, cardCount, rng);
  // Allineato per indice a `cards`: null dove la card resta ad autovalutazione,
  // o dove l'interruttore è spento.
  const cardItems = cards.map((c) => (state.prefs.cardMcq === false ? null : prepareCardItem(c, rng)));

  if (!mcqItems.length && !cards.length) {
    toast('Scegli almeno una domanda o una flashcard.', 'error');
    return;
  }

  state.session = {
    mode,
    lessons: picked,
    startedAt: new Date().toISOString(),
    mcqItems,
    answers: {},
    index: 0,
    phase: mcqItems.length ? 'mcq' : 'cards',
    cards,
    cardItems,
    cardIndex: 0,
    cardResults: {},
    cardRevealed: false,
    cardAnswered: false,
    // Opzione selezionata ma non ancora confermata (lettera MOSTRATA).
    cardChoice: null,
    mcqScore: null,
  };
  state.results = null;
  ctx.goTo('quiz');
}

function submitMcq() {
  const s = state.session;
  s.mcqScore = scoreMcq(s.mcqItems, s.answers);
  if (s.cards.length) {
    s.phase = 'cards';
    s.cardRevealed = false;
    s.cardAnswered = false;
    render();
  } else {
    finishSession();
  }
}

/** Flashcard ad autovalutazione: la valutazione chiude subito la card. */
function answerCard(known) {
  const s = state.session;
  const card = s.cards[s.cardIndex];
  s.cardResults[card.id] = { mode: 'self', correct: !!known };
  advanceCard();
}

/**
 * Flashcard a risposta multipla, primo passo: selezione REVOCABILE di
 * un'opzione. Come nel blocco MCQ, ri-cliccare la stessa opzione la
 * deseleziona. L'esito non compare finché non si conferma — un tocco storto
 * non deve bruciare la card.
 */
function chooseCardMcq(displayKey) {
  const s = state.session;
  const item = s.cardItems[s.cardIndex];
  if (!item || s.cardAnswered) return;
  s.cardChoice = s.cardChoice === displayKey ? null : displayKey;
  render();
}

/**
 * Secondo passo: la conferma non chiude la card ma apre la fase di feedback
 * (corretta/sbagliata e risposta integrale sotto gli occhi). `cardChoice` è la
 * lettera MOSTRATA; la conversione in quella del file è la stessa del blocco
 * MCQ, quindi la correzione non dipende dal rimescolamento.
 */
function answerCardMcq() {
  const s = state.session;
  const card = s.cards[s.cardIndex];
  const item = s.cardItems[s.cardIndex];
  const displayKey = s.cardChoice;
  if (!item || s.cardAnswered || !displayKey) return;
  const givenKey = toOriginalKey(item, displayKey);
  s.cardResults[card.id] = {
    mode: 'mcq',
    displayKey,
    givenKey,
    correct: givenKey === item.question.correctKey,
  };
  s.cardAnswered = true;
  render();
}

function advanceCard() {
  const s = state.session;
  s.cardIndex += 1;
  s.cardRevealed = false;
  s.cardAnswered = false;
  s.cardChoice = null;
  if (s.cardIndex >= s.cards.length) finishSession();
  else render();
}

function abortSession() {
  state.session = null;
  ctx.goTo('config');
}

function finishSession() {
  const s = state.session;
  const mcqScore = s.mcqScore || scoreMcq(s.mcqItems, s.answers);
  // Una sessione può mescolare i due modi: le card con distrattori curati sono
  // corrette nel merito, le altre restano autovalutate. `correct` è comunque
  // popolato per entrambe — è l'unico campo che lo storico rilegge.
  const cardDetail = s.cards.map((card, i) => {
    const res = s.cardResults[card.id] || { mode: s.cardItems[i] ? 'mcq' : 'self', correct: false };
    return {
      card,
      item: s.cardItems[i] || null,
      mode: res.mode,
      givenKey: res.givenKey || null,
      displayKey: res.displayKey || null,
      correct: !!res.correct,
    };
  });
  const selfDetail = cardDetail.filter((c) => c.mode === 'self');
  const cardMcqDetail = cardDetail.filter((c) => c.mode === 'mcq');

  const attempt = {
    uid: storage.newUid(),
    ts: new Date().toISOString(),
    exam: state.slug,
    mode: s.mode,
    items: [
      ...mcqScore.detail.map((d) => ({
        id: d.id,
        type: 'mcq',
        lesson: d.question.lesson,
        givenKey: d.givenKey,
        correct: d.correct,
        // snapshot leggibile dall'LLM senza dover incrociare gli id
        text: d.question.text,
        contentHash: d.question.contentHash,
      })),
      ...cardDetail.map((c) => ({
        id: c.card.id,
        type: 'card',
        lesson: c.card.lesson,
        ...(c.mode === 'mcq'
          ? { givenKey: c.givenKey }
          : { selfEval: c.correct ? 'sapevo' : 'non-sapevo' }),
        correct: c.correct,
        text: c.card.question,
        contentHash: c.card.contentHash,
      })),
    ],
    score: {
      mcqCorrect: mcqScore.correct,
      mcqTotal: mcqScore.total,
      mcqPlatformCorrect: mcqScore.platformCorrect,
      // `cardsKnown/cardsTotal` restano il conteggio delle sole autovalutate,
      // così le sessioni vecchie e nuove si leggono allo stesso modo.
      cardsKnown: selfDetail.filter((c) => c.correct).length,
      cardsTotal: selfDetail.length,
      cardMcqCorrect: cardMcqDetail.filter((c) => c.correct).length,
      cardMcqTotal: cardMcqDetail.length,
    },
  };

  state.log = storage.addAttempt(state.log, attempt);
  if (!storage.saveLog(state.slug, state.log)) {
    toast('Storico non salvato (localStorage non disponibile o pieno).', 'error');
  }
  if (state.sync) {
    pushSessions(state.slug, [attempt]).then((res) => {
      if (!res) toast('Sessione non sincronizzata col server: resta salvata qui.', 'error');
    });
  }

  state.results = {
    attempt,
    mcq: mcqScore,
    cards: {
      total: cardDetail.length,
      selfTotal: selfDetail.length,
      selfKnown: selfDetail.filter((c) => c.correct).length,
      mcqTotal: cardMcqDetail.length,
      mcqCorrect: cardMcqDetail.filter((c) => c.correct).length,
      detail: cardDetail,
    },
  };
  state.session = null;
  ctx.goTo('results');
}

// ---------------------------------------------------------------------------
// Export / import / reset
// ---------------------------------------------------------------------------

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export del solo esame corrente: è il file che alimenta il wiki.
 * Il nome porta lo slug perché esportando due esami di seguito il vecchio nome
 * fisso produceva `quiz-errori (1).json`, indistinguibili fra loro.
 */
function exportLog() {
  if (!state.slug) return;
  download(`quiz-errori-${state.slug}.json`, storage.serializeLog(state.log));
  toast(`Scaricato — rinominalo in exams/${state.slug}/quiz-errori.json e committalo.`);
}

/** Backup di tutti gli esami + preferenze: il salvataggio prima di un rifacimento. */
function exportBackup() {
  const logs = {};
  for (const slug of storage.listExams()) logs[slug] = storage.loadLog(slug);
  // Lo stato in memoria dell'esame aperto è la versione più fresca (contiene
  // già l'eventuale merge remoto di questo avvio).
  if (state.slug) logs[state.slug] = state.log;

  const slugs = Object.keys(logs);
  if (!slugs.length) {
    toast('Nessuno storico da salvare.', 'error');
    return;
  }
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  download(`lm77-quiz-backup-${day}.json`,
    storage.serializeBackup(storage.buildBackup(logs, state.prefs, now.toISOString())));
  toast(`Backup di ${slugs.length} ${slugs.length === 1 ? 'esame' : 'esami'} scaricato.`);
}

/**
 * Import di uno storico. Riconosce entrambi i formati e — punto importante —
 * instrada le sessioni nell'esame a cui APPARTENGONO, non in quello aperto:
 * prima il file di un esame importato mentre ne era selezionato un altro
 * finiva in silenzio nella chiave sbagliata.
 */
async function importFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast(`File non valido: ${err.message}`, 'error');
    return;
  }

  const backup = storage.parseBackup(parsed);
  const logs = backup ? backup.exams : singleExamPayload(parsed);
  if (!logs) return; // singleExamPayload ha già spiegato perché

  const known = new Set(state.manifest.map((e) => e.slug));
  const added = [];
  const ignored = [];
  const pushed = [];
  let dropped = 0;

  for (const [slug, incoming] of Object.entries(logs)) {
    if (!known.has(slug)) { ignored.push(slug); continue; }
    const base = slug === state.slug ? state.log : storage.loadLog(slug);
    const res = storage.mergeLogsWithStats(base, incoming);
    dropped += res.dropped;
    if (res.added) {
      storage.saveLog(slug, res.log);
      added.push(`${slug} +${res.added}`);
      // Anche l'archivio del server va allineato SUBITO, per ogni esame del
      // file. Altrimenti, dopo aver importato un backup multi-esame su un
      // cluster nuovo, salirebbe solo l'esame aperto: gli altri aspetterebbero
      // che ci si passi sopra a mano, perché il push sta in selectExam().
      // Si mandano le sessioni del file, non quelle unite: il server unisce
      // per uid, quindi il risultato è identico e il corpo è più piccolo.
      if (state.sync) pushed.push(pushSessions(slug, incoming.sessions));
    }
    if (slug === state.slug) state.log = res.log;
  }

  if (backup && backup.prefs) applyImportedPrefs(backup.prefs);

  const parts = [];
  parts.push(added.length ? `Importate: ${added.join(', ')}.` : 'Nessuna sessione nuova: lo storico era già allineato.');
  if (dropped) parts.push(`⚠️ ${dropped} sessioni più vecchie scartate (se ne tengono ${storage.SESSION_CAP}).`);
  if (ignored.length) parts.push(`Ignorati, non nel manifest: ${ignored.join(', ')}.`);
  toast(parts.join(' '), ignored.length ? 'error' : undefined);
  render();

  // Dopo aver ridisegnato: l'import è già salvato in locale, il server è un di
  // più e un suo errore non deve trattenere la schermata.
  if (pushed.length) {
    const falliti = (await Promise.all(pushed)).filter((r) => !r).length;
    if (falliti) {
      toast(`${falliti} ${falliti === 1 ? 'esame non sincronizzato' : 'esami non sincronizzati'} col server: restano salvati qui.`, 'error');
    }
  }
}

/** ErrorLog singolo → mappa {slug: log}. null (con toast) se manca lo slug. */
function singleExamPayload(parsed) {
  const slug = parsed && typeof parsed === 'object' && typeof parsed.exam === 'string'
    ? parsed.exam.trim() : '';
  if (!slug) {
    toast('File privo del campo "exam": non è possibile sapere a quale esame appartiene.', 'error');
    return null;
  }
  return { [slug]: storage.normalizeLog(parsed, slug) };
}

/**
 * Dal backup si recuperano solo le lunghezze della prova. L'esame selezionato
 * NON viene toccato: cambiarlo sotto i piedi durante un import sarebbe una
 * sorpresa, e chi importa sta guardando l'esame che ha scelto. Per la stessa
 * ragione resta fuori anche `lessons`: la selezione delle lezioni è la parte
 * più volatile della configurazione, e ripristinarla da un backup vecchio
 * ridurrebbe in silenzio il pool della prova successiva.
 */
function applyImportedPrefs(prefs) {
  for (const k of ['simTotal', 'mcqCount', 'cardCount']) {
    if (Number.isFinite(prefs[k])) state.prefs[k] = prefs[k];
  }
  // `cardMcq` è booleana: senza un ramo dedicato il filtro numerico qui sopra
  // la scarterebbe in silenzio a ogni import di backup.
  if (typeof prefs.cardMcq === 'boolean') state.prefs.cardMcq = prefs.cardMcq;
  storage.savePrefs(state.prefs);
}

function resetLog() {
  if (!state.slug) return;
  if (!window.confirm('Svuotare lo storico locale di questo esame? L\'operazione non è reversibile.')) return;
  storage.clearLog(state.slug);
  state.log = storage.emptyLog(state.slug);
  toast('Storico svuotato.');
  render();
}

// ---------------------------------------------------------------------------

/**
 * PWA nella sola build pubblica. Nel repo privato config-pubblico.json non
 * esiste, il flag resta falso e qui non succede nulla — se non ripulire un
 * service worker rimasto da una prova della build pubblica sulla stessa
 * origine, che altrimenti servirebbe all'app privata un guscio vecchio.
 */
async function registraServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const app = appUrl('');
  // Il service worker sta nella RADICE del sito, non accanto all'app: solo da
  // lì può avere scope `/` e quindi coprire anche la pagina di rimbalzo della
  // radice, che è ciò che iOS installa se si aggiunge alla schermata Home da
  // «lm77-quiz.github.io» invece che da «…/tools/quiz/». Registrare uno script
  // di radice da una pagina più interna è lecito: il vincolo è che lo scope
  // stia sotto il percorso dello script, non sotto quello della pagina.
  const radice = repoUrl('');
  try {
    if (state.config.pubblico) {
      await navigator.serviceWorker.register(repoUrl('sw.js'), { scope: radice });
      // Bonifica delle registrazioni più strette di questa: fino alla versione
      // con la PWA ancorata alla radice il service worker stava accanto
      // all'app, con scope /tools/quiz/. Uno scope più specifico VINCE su
      // quello di radice, quindi finché resta continuerebbe a servire lui il
      // guscio vecchio. Da solo sparirebbe comunque — il suo script ora dà 404
      // e il browser disinstalla — ma non subito, e nel frattempo le due cache
      // si cancellerebbero a vicenda.
      for (const reg of await navigator.serviceWorker.getRegistrations()) {
        if (reg.scope !== radice && reg.scope.startsWith(radice)) await reg.unregister();
      }
      return;
    }
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      // Tutti quelli che controllerebbero questa pagina, di radice o d'app:
      // sulla stessa localhost possono girare altri progetti, e quelli no.
      if (app.startsWith(reg.scope) || reg.scope.startsWith(app)) await reg.unregister();
    }
  } catch (err) {
    // Niente PWA: l'app resta esattamente quella di prima.
  }
}

async function boot() {
  try {
    // probe() e loadConfig() non lanciano mai: il catch qui sotto copre solo
    // il manifest.
    const [manifest, sync, config] = await Promise.all([loadManifest(), probe(), loadConfig()]);
    state.manifest = manifest;
    state.sync = sync || false;
    state.config = config;
  } catch (err) {
    state.loading = false;
    root.textContent = '';
    root.append(Object.assign(document.createElement('p'), {
      className: 'banner banner-error',
      textContent: `${err.message} Avvia un server dalla root del repo: python3 -m http.server 8000, poi apri http://localhost:8000/tools/quiz/`,
    }));
    return;
  }
  const preferred = state.manifest.find((e) => e.slug === state.prefs.exam)
    || state.manifest.find((e) => e.slug === 'analisi-dei-mercati-finanziari')
    || state.manifest[0];
  if (preferred) await selectExam(preferred.slug);
  else { state.loading = false; render(); }
  // Non atteso: la registrazione non deve ritardare la prima schermata.
  registraServiceWorker();
}

boot();
