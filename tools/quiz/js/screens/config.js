// screens/config.js — schermata di configurazione della simulazione.

import { el, clear } from '../dom.js';
import { summarize } from '../storage.js';
import {
  countReviewable, planSimCounts, SIM_TOTAL, cardHasMcq,
  lessonPool, filterByLessons, MAX_LESSONS,
} from '../engine.js';
import { repoUrl } from '../discovery.js';

const ANNI = { 1: '1° anno', 2: '2° anno' };

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Riepilogo del totale, es. «Totale: 30 domande — 15 quiz + 15 flashcard». */
function totalText(plan) {
  return `Totale: ${plan.total} domande — ${plan.mcq} quiz + ${plan.cards} flashcard`;
}

/**
 * Coppia slider + campo numerico sincronizzati, con estremi [min, max].
 * `onInput` viene invocato solo quando il valore cambia per gesto dell'utente:
 * `setValue()`/`setBounds()` scrivono i due input senza generare eventi, quindi
 * contatori legati fra loro non entrano mai in ricorsione.
 *
 * Estremi e hint sono MUTABILI: il cursore del totale li cambia sotto agli
 * altri due. Si mutano gli attributi dei nodi esistenti — ricostruirli
 * interromperebbe il trascinamento in corso e perderebbe il fuoco.
 */
function counter({ id, label, hint, min = 0, max, value, disabled, onInput }) {
  const forced = !!disabled;
  let lo = Math.max(0, Math.min(min, max));
  let hi = Math.max(lo, max);
  const clamp = (v) => {
    const n = Math.round(Number(v));
    return Math.max(lo, Math.min(Number.isFinite(n) ? n : lo, hi));
  };
  const locked = forced || lo === hi;

  const range = el('input', {
    type: 'range', id: `${id}-range`, min: String(lo), max: String(hi),
    value: String(clamp(value)), disabled: locked,
    'aria-label': `${label} (cursore)`,
  });
  const number = el('input', {
    type: 'number', id, min: String(lo), max: String(hi), value: String(clamp(value)),
    inputmode: 'numeric', disabled: locked,
    'aria-label': `${label} (valore)`,
  });
  const hintEl = el('p', { class: 'hint', text: hint });

  const write = (v) => {
    range.value = String(v);
    number.value = String(v);
  };
  // `echo = false` non riscrive la sorgente: serve al campo numerico, che
  // altrimenti verrebbe riscritto a ogni tasto e non si potrebbe svuotare
  // per ridigitarlo (`Number('') === 0` ⇒ tornerebbe subito al minimo).
  const handle = (source, echo = true) => {
    const v = clamp(source.value);
    if (echo) write(v);
    else range.value = String(v);
    if (onInput) onInput(v);
  };
  range.addEventListener('input', () => handle(range));
  number.addEventListener('input', () => handle(number, false));
  number.addEventListener('change', () => handle(number));
  number.addEventListener('blur', () => handle(number));

  return {
    node: el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: id, text: label }),
      el('div', { class: 'counter' }, [range, number]),
      hintEl,
    ]),
    get value() { return clamp(number.value); },
    /** Aggiornamento programmatico: non rilancia `onInput`. */
    setValue(v) { write(clamp(v)); },
    /**
     * Nuovi estremi. Il valore corrente si rilegge dal campo NUMERICO: lo
     * slider ri-clampa da solo il proprio `.value` appena si riscrivono
     * `min`/`max`, quindi leggerlo da lì perderebbe la scelta dell'utente.
     */
    setBounds(nextMin, nextMax) {
      lo = Math.max(0, Math.min(nextMin, nextMax));
      hi = Math.max(lo, nextMax);
      range.min = String(lo);
      range.max = String(hi);
      number.min = String(lo);
      number.max = String(hi);
      const nowLocked = forced || lo === hi;
      range.disabled = nowLocked;
      number.disabled = nowLocked;
      write(clamp(number.value));
    },
    setHint(text) { hintEl.textContent = text; },
  };
}

export function renderConfig(root, ctx) {
  clear(root);
  const { state } = ctx;
  const exam = state.exam;
  const prefs = state.prefs;

  // --- selezione esame ---------------------------------------------------
  const select = el('select', { id: 'exam-select', class: 'select' });
  const groups = {};
  for (const e of state.manifest) {
    const anno = ANNI[e.anno] || 'Altro';
    if (!groups[anno]) {
      groups[anno] = el('optgroup', { label: anno });
      select.append(groups[anno]);
    }
    groups[anno].append(el('option', {
      value: e.slug,
      text: e.nome,
      selected: state.slug === e.slug,
    }));
  }
  select.value = state.slug || '';
  select.addEventListener('change', () => ctx.selectExam(select.value));

  const header = el('section', { class: 'card' }, [
    el('h2', { text: 'Configura la simulazione' }),
    el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'exam-select', text: 'Esame' }),
      select,
    ]),
    state.loading ? el('p', { class: 'hint', text: 'Caricamento dei materiali…' }) : null,
  ]);
  root.append(header);

  if (state.loading || !exam) return;

  // --- disponibilità -----------------------------------------------------
  // Conteggi dell'INTERO esame: le pillole qui sotto descrivono i materiali,
  // non la prova. Il pool su cui la prova pesca davvero è più in basso e
  // dipende dal filtro per lezione.
  const totMcq = exam.questions.length;
  const totCards = exam.cards.length;
  const totCardsMcq = exam.cards.filter(cardHasMcq).length;

  if (exam.errors.length) {
    header.append(el('p', { class: 'banner banner-error', text: exam.errors.join(' · ') }));
  }

  if (totMcq === 0 && totCards === 0) {
    root.append(el('section', { class: 'card' }, [
      el('p', { class: 'banner banner-info' },
        `Per «${exam.nome}» non ci sono ancora domande né flashcard: i materiali si popolano man mano che le lezioni vengono elaborate.`),
    ]));
    return;
  }

  // Le due pillole sui quiz spariscono quando non ce ne sono: è il caso della
  // build pubblica, che esporta le sole flashcard. In privato non si vede,
  // perché un esame con flashcard e zero domande non esiste (e il caso
  // «entrambi vuoti» è già uscito qui sopra).
  root.append(el('p', { class: 'stats' }, [
    totMcq ? el('span', { class: 'pill', text: `${totMcq} domande a risposta multipla` }) : null,
    el('span', { class: 'pill', text: totCardsMcq ? `${totCards} flashcard, ${totCardsMcq} a risposta multipla` : `${totCards} flashcard` }),
    totMcq ? el('span', { class: 'pill', text: `${exam.quiz.lessons.filter((l) => l.count).length} lezioni con quiz` }) : null,
  ]));

  // Il README dell'esame è già l'indice delle lezioni, con i link a tutte le
  // note: aperto nel browser arriva impaginato (vedi serve.py), quindi da qui
  // si raggiunge l'intero wiki dell'esame senza una schermata dedicata. Nella
  // build pubblica il wiki non è stato esportato e il link sarebbe un 404.
  if (state.config.wiki) root.append(el('p', { class: 'hint' }, [
    el('a', {
      class: 'link',
      href: repoUrl(`exams/${exam.slug}/README.md`),
      target: '_blank',
      rel: 'noopener',
      text: 'Sfoglia i materiali dell\'esame ↗',
    }),
  ]));

  // --- filtro per lezione ---------------------------------------------------
  // L'elenco si ricava dagli item (lessonPool), non da `exam.quiz.lessons`:
  // così ogni voce mostrata contiene davvero qualcosa da pescare, comprese le
  // lezioni che hanno solo flashcard.
  const lessons = lessonPool(exam.questions, exam.cards);
  const savedLessons = ((prefs.lessons || {})[exam.slug] || []).map(String);
  const known = new Set(lessons.map((l) => l.number));
  // Si intersecano con le lezioni esistenti: una selezione salvata prima che i
  // materiali cambiassero non deve svuotare la prova in silenzio.
  const selected = new Set(savedLessons.filter((n) => known.has(n)).slice(0, MAX_LESSONS));
  let filterOn = selected.size > 0;

  // Pool EFFETTIVO della prova. Sono `let` perché le hint dei cursori e i piani
  // li rileggono a ogni cambio di selezione, senza ridisegnare la schermata.
  let nMcq = 0;
  let nCards = 0;
  let nCardsMcq = 0;
  let pool = 0;
  let poolItems = [];

  function recomputeAvail() {
    // Filtro acceso ma nessuna lezione scelta: pool vuoto, non «tutte». Senza
    // questo caso i contatori mostrerebbero l'intero esame mentre i bottoni
    // sono disabilitati, che è una bugia a schermo.
    const list = filterOn ? Array.from(selected) : [];
    const blank = filterOn && !list.length;
    const qs = blank ? [] : filterByLessons(exam.questions, list);
    const cs = blank ? [] : filterByLessons(exam.cards, list);
    nMcq = qs.length;
    nCards = cs.length;
    nCardsMcq = cs.filter(cardHasMcq).length;
    pool = nMcq + nCards;
    poolItems = [...qs, ...cs];
  }
  recomputeAvail();

  // --- tre contatori legati -------------------------------------------------
  // Il cursore del totale fissa la lunghezza della prova (da 1 al numero di
  // item disponibili, default SIM_TOTAL); gli altri due sono l'uno il
  // complemento dell'altro rispetto a quel totale. I valori salvati nelle prefs
  // vengono ri-normalizzati dal plan (le MCQ fanno da guida), così non si
  // ripristinano mai stati incoerenti — nemmeno un totale salvato su un esame
  // con più materiali di quello corrente.
  //
  // `wantTotal` e `wantMcq` sono ciò che l'utente ha CHIESTO, prima di essere
  // limitato dal pool: restringendo e riallargando la selezione delle lezioni
  // la prova torna alla lunghezza voluta invece di restare schiacciata sul
  // minimo toccato per strada.
  let wantTotal = Math.max(1, Math.round(Number(prefs.simTotal)) || SIM_TOTAL);
  const plan = planSimCounts(nMcq, nCards, { type: 'mcq', value: prefs.mcqCount ?? wantTotal }, wantTotal);
  let total = plan.total;
  let wantMcq = plan.mcq;

  const mcqHint = (p) => `Disponibili: ${nMcq}. In simulazione: da ${p.mcqMin} a ${p.mcqMax}; il resto del totale viene completato con le flashcard.`;
  const cardHint = (p) => `Disponibili: ${nCards}${nCardsMcq ? ` (${nCardsMcq} con distrattori curati)` : ''}. In simulazione: da ${p.cardMin} a ${p.cardMax}. Vengono poste dopo le domande a risposta multipla.`;
  const totalHint = () => `Lunghezza della prova: da 1 a ${pool} (${filterOn ? 'gli item delle lezioni scelte' : 'tutti gli item disponibili'}). Default: ${SIM_TOTAL}.`;

  const totalCounter = counter({
    id: 'total-count',
    label: 'Totale domande',
    hint: totalHint(),
    min: 1,
    max: pool,
    value: plan.total,
    onInput: (v) => {
      wantTotal = v;
      applyPlan(planSimCounts(nMcq, nCards, { type: 'mcq', value: wantMcq }, v), 'total');
    },
  });
  const mcqCounter = counter({
    id: 'mcq-count',
    label: 'Domande a risposta multipla',
    hint: mcqHint(plan),
    min: plan.mcqMin,
    max: plan.mcqMax,
    value: plan.mcq,
    onInput: (v) => syncFrom({ type: 'mcq', value: v }),
  });
  const cardCounter = counter({
    id: 'card-count',
    label: 'Flashcard',
    hint: cardHint(plan),
    min: plan.cardMin,
    max: plan.cardMax,
    value: plan.cards,
    onInput: (v) => syncFrom({ type: 'cards', value: v }),
  });

  const totalLine = el('p', { class: 'sim-total', 'aria-live': 'polite', text: totalText(plan) });
  // Avviso «i materiali non bastano»: è vivo, perché con il filtro per lezione
  // il pool cambia sotto ai cursori e un banner scritto una volta sola
  // resterebbe a mentire.
  const poolNote = el('p', { class: 'banner banner-info', hidden: true });

  // Le flashcard con distrattori curati si giocano a risposta multipla; questo
  // interruttore le riporta all'autovalutazione, che è un esercizio diverso e
  // più severo (la risposta va prodotta, non riconosciuta).
  const cardMcqInput = el('input', {
    type: 'checkbox',
    id: 'card-mcq',
    checked: state.prefs.cardMcq !== false,
    disabled: totCardsMcq === 0,
  });
  const cardMcqToggle = el('p', { class: 'toggle' }, [
    el('label', { for: 'card-mcq' }, [
      cardMcqInput,
      el('span', { text: ' Flashcard a risposta multipla' }),
    ]),
    el('span', {
      class: 'hint',
      text: totCardsMcq === 0
        ? 'Nessuna flashcard di questo esame ha ancora i distrattori: restano tutte ad autovalutazione.'
        : `${totCardsMcq} flashcard su ${totCards} hanno distrattori curati. Le altre restano ad autovalutazione in ogni caso.`,
    }),
  ]);

  /**
   * Riporta un piano sui tre controlli. `lead` è quello che l'utente sta
   * muovendo e NON va mai riscritto sotto le dita. Per ciascun contatore
   * l'ordine è obbligato: prima gli estremi, poi il valore (scriverlo prima di
   * allargare gli estremi lo troncherebbe sui limiti vecchi).
   */
  function applyPlan(next, lead) {
    total = next.total;
    if (lead !== 'mcq') {
      mcqCounter.setBounds(next.mcqMin, next.mcqMax);
      mcqCounter.setValue(next.mcq);
    }
    if (lead !== 'cards') {
      cardCounter.setBounds(next.cardMin, next.cardMax);
      cardCounter.setValue(next.cards);
    }
    mcqCounter.setHint(mcqHint(next));
    cardCounter.setHint(cardHint(next));
    totalLine.textContent = totalText(next);
    const short = next.insufficient && next.total > 0;
    poolNote.hidden = !short;
    if (short) {
      poolNote.textContent = `Gli item disponibili sono ${next.total} in tutto (${nMcq} quiz + ${nCards} flashcard): la prova da ${next.target} non è raggiungibile.`;
    }
  }

  // Il totale corrente va sempre ripassato al plan: senza, i due contatori
  // complementari riporterebbero la prova al default a ogni tocco. Muovere uno
  // dei due è anche l'unico modo di cambiare le MCQ *volute*.
  function syncFrom(lead) {
    const next = planSimCounts(nMcq, nCards, lead, total);
    wantMcq = next.mcq;
    applyPlan(next, lead.type);
  }

  // --- selezione delle lezioni (UI) ----------------------------------------
  const lessonHint = el('p', { class: 'hint', 'aria-live': 'polite' });
  const lessonBoxes = new Map();
  const lessonGrid = el('div', {
    class: 'lesson-grid',
    role: 'group',
    'aria-label': 'Lezioni comprese nella prova',
  });
  for (const l of lessons) {
    const box = el('input', {
      type: 'checkbox',
      id: `lesson-${l.number}`,
      value: l.number,
      checked: selected.has(l.number),
    });
    box.addEventListener('change', () => {
      if (box.checked) {
        // Il tetto si difende anche qui, non solo disabilitando le caselle:
        // da tastiera o con un doppio evento la spunta arriverebbe comunque.
        if (selected.size >= MAX_LESSONS) { box.checked = false; return; }
        selected.add(l.number);
      } else {
        selected.delete(l.number);
      }
      onLessonChange();
    });
    lessonBoxes.set(l.number, box);
    lessonGrid.append(el('label', { class: 'lesson-item', for: `lesson-${l.number}` }, [
      box,
      el('span', { class: 'lesson-name', text: `${l.number} — ${l.title}` }),
      el('span', { class: 'lesson-count', text: totMcq ? `${l.mcq} quiz · ${l.cards} flashcard` : `${l.cards} flashcard` }),
    ]));
  }

  const filterInput = el('input', { type: 'checkbox', id: 'lesson-filter', checked: filterOn });
  filterInput.addEventListener('change', () => {
    filterOn = filterInput.checked;
    // La selezione resta in memoria quando si spegne l'interruttore: riaccenderlo
    // per sbaglio non deve costare il lavoro di rispuntare sei caselle.
    onLessonChange();
  });
  const lessonToggle = el('p', { class: 'toggle' }, [
    el('label', { for: 'lesson-filter' }, [
      filterInput,
      el('span', { text: ` Limita alle lezioni scelte (max ${MAX_LESSONS})` }),
    ]),
  ]);

  /**
   * Un cambio di selezione ricalcola il pool e riporta i tre cursori sui nuovi
   * estremi SENZA ridisegnare la schermata: un `rerender()` perderebbe il fuoco
   * sulla casella appena cliccata e la posizione di scorrimento dell'elenco.
   */
  function onLessonChange() {
    recomputeAvail();
    const next = planSimCounts(nMcq, nCards, { type: 'mcq', value: wantMcq }, wantTotal);
    totalCounter.setBounds(pool ? 1 : 0, pool);
    totalCounter.setValue(next.total);
    totalCounter.setHint(totalHint());
    applyPlan(next, null);
    updateLessonUi();
  }

  function updateLessonUi() {
    lessonGrid.hidden = !filterOn;
    for (const [number, box] of lessonBoxes) {
      box.disabled = !filterOn || (!selected.has(number) && selected.size >= MAX_LESSONS);
    }
    const blank = filterOn && !selected.size;
    lessonHint.textContent = !filterOn
      ? `La prova pesca da tutte le ${lessons.length} lezioni dell'esame.`
      : blank
        ? 'Scegli almeno una lezione.'
        : `${selected.size} di ${MAX_LESSONS} lezioni selezionate: ${nMcq} quiz + ${nCards} flashcard nel pool.`;
    startBtn.disabled = pool === 0;
    reviewBtn.disabled = pool === 0;
    // Domande e flashcard insieme: il ripasso pesa gli errori di entrambe, e il
    // conteggio deve seguire il filtro come lo segue il pool.
    const reviewable = countReviewable(poolItems, state.log.perQuestion);
    reviewBtn.textContent = reviewable ? `Ripassa errori (${reviewable})` : 'Ripassa errori';
    reviewBtn.title = reviewable
      ? 'Le domande sbagliate in passato, pesate per frequenza e recenza dell\'errore.'
      : 'Nessun errore in archivio: verranno proposte domande non ancora viste.';
  }

  // --- avvio ----------------------------------------------------------------
  const sessionOpts = () => ({
    mcqCount: mcqCounter.value,
    cardCount: cardCounter.value,
    simTotal: totalCounter.value,
    cardMcq: cardMcqInput.checked,
    lessons: filterOn ? Array.from(selected) : [],
  });

  const startBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Inizia simulazione' });
  startBtn.addEventListener('click', () => ctx.startSession({ mode: 'sim', ...sessionOpts() }));

  const reviewBtn = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Ripassa errori' });
  reviewBtn.addEventListener('click', () => ctx.startSession({
    ...sessionOpts(),
    mode: 'review',
    mcqCount: mcqCounter.value || Math.min(10, nMcq),
  }));

  root.append(el('section', { class: 'card' }, [
    el('p', { class: 'hint', text: 'I tre cursori sono legati: il primo fissa la lunghezza della prova, gli altri due sono complementari — alzando l\'uno si abbassa l\'altro.' }),
    lessonToggle,
    lessonGrid,
    lessonHint,
    totalCounter.node,
    // Costruito comunque: applyPlan() lo riscrive a ogni tocco degli altri due.
    totMcq ? mcqCounter.node : null,
    cardCounter.node,
    totalLine,
    poolNote,
    cardMcqToggle,
    el('div', { class: 'actions' }, [startBtn, reviewBtn]),
  ]));

  // Primo allineamento: bottoni, elenco e avviso del pool partono coerenti con
  // la selezione ripristinata dalle prefs.
  applyPlan(plan, null);
  updateLessonUi();

  // --- storico -----------------------------------------------------------
  const s = summarize(state.log);
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', id: 'import-file' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) ctx.importFile(file);
    fileInput.value = '';
  });

  const importBtn = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Importa JSON…' });
  importBtn.addEventListener('click', () => fileInput.click());

  const exportBtn = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Esporta quiz-errori.json' });
  exportBtn.addEventListener('click', () => ctx.exportLog());

  const backupBtn = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Backup completo' });
  backupBtn.addEventListener('click', () => ctx.exportBackup());

  const resetBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-danger', text: 'Svuota storico' });
  resetBtn.addEventListener('click', () => ctx.resetLog());

  root.append(el('section', { class: 'card' }, [
    el('h2', { text: 'Storico' }),
    el('dl', { class: 'kv' }, [
      el('dt', { text: 'Sessioni registrate' }), el('dd', { text: String(s.sessions) }),
      el('dt', { text: 'Domande/flashcard tracciate' }), el('dd', { text: String(s.tracked) }),
      el('dt', { text: 'Con almeno un errore' }), el('dd', { text: String(s.wrong) }),
      el('dt', { text: 'Ultima sessione' }), el('dd', { text: fmtDate(s.lastAt) }),
    ]),
    state.remoteMerged
      ? el('p', { class: 'hint', text: `Importato automaticamente exams/${exam.slug}/quiz-errori.json.` })
      : null,
    // Se il server non archivia lo storico non compare nulla: l'app è quella
    // di sempre e non c'è motivo di parlare di una capacità che non esiste.
    state.sync
      ? el('p', { class: 'hint', text: state.sync.user && state.sync.user !== 'local'
        ? `Sincronizzato col server come ${state.sync.user}: lo storico segue l'utente, non il browser.`
        : 'Sincronizzato con l\'archivio del server: lo storico non vive solo in questo browser.' })
      : null,
    el('div', { class: 'actions actions-wrap' }, [exportBtn, backupBtn, importBtn, resetBtn, fileInput]),
    el('p', { class: 'hint', text: 'L\'export del singolo esame va committato in exams/' + exam.slug + '/quiz-errori.json: al prossimo avvio viene reimportato automaticamente (merge idempotente per uid della sessione). Il backup completo raccoglie invece tutti gli esami e le preferenze in un file solo, da tenere da parte.' }),
  ]));

  if (exam.warnings.length) {
    root.append(el('details', { class: 'card card-muted' }, [
      el('summary', { text: `Avvisi del parser (${exam.warnings.length})` }),
      el('ul', {}, exam.warnings.map((w) => el('li', { text: `${w.id ? `${w.id}: ` : ''}${w.message}` }))),
    ]));
  }
}
