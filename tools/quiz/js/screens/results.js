// screens/results.js — riepilogo e correzione.
//
// Nel riepilogo le opzioni tornano nell'ORDINE ORIGINALE del file: le
// spiegazioni citano le lettere originali («Perché B è sbagliata»), quindi
// mostrarle rimescolate le renderebbe illeggibili.

import { el, clear } from '../dom.js';
import { mdInline } from '../md-inline.js';

export function renderResults(root, ctx) {
  clear(root);
  const r = ctx.state.results;
  if (!r) { ctx.goTo('config'); return; }

  const { mcq, cards, attempt } = r;

  // --- intestazione ------------------------------------------------------
  const head = el('section', { class: 'card' }, [
    el('h2', { text: attempt.mode === 'review' ? 'Riepilogo del ripasso' : 'Riepilogo della simulazione' }),
  ]);

  if (mcq.total) {
    head.append(el('p', { class: 'score' }, [
      el('strong', { text: `${mcq.correct}/${mcq.total}` }),
      el('span', { class: 'muted', text: ` risposte corrette (${pct(mcq.correct, mcq.total)}%)` }),
    ]));
    if (mcq.blank) head.append(el('p', { class: 'hint', text: `${mcq.blank} lasciate in bianco.` }));
    if (mcq.hasPlatformMismatch) {
      head.append(el('p', { class: 'banner banner-alarm' },
        '🚨 Questa sessione contiene domande per cui la chiave della piattaforma è difforme dalle slide. Il punteggio qui sopra è quello nel merito (risposta ✅ conforme alle slide).'));
      head.append(el('p', { class: 'score-secondary', text: `Punteggio secondo la chiave della piattaforma: ${mcq.platformCorrect}/${mcq.total}.` }));
    }
  }
  // Le due quote hanno significati diversi e non vanno sommate: una è una
  // correzione nel merito, l'altra un giudizio di chi studia su se stesso.
  if (cards.mcqTotal) {
    head.append(el('p', { class: 'score' }, [
      el('strong', { text: `${cards.mcqCorrect}/${cards.mcqTotal}` }),
      el('span', { class: 'muted', text: ` flashcard corrette (${pct(cards.mcqCorrect, cards.mcqTotal)}%)` }),
    ]));
  }
  if (cards.selfTotal) {
    head.append(el('p', { class: 'score' }, [
      el('strong', { text: `${cards.selfKnown}/${cards.selfTotal}` }),
      el('span', { class: 'muted', text: ' flashcard dichiarate sapute' }),
    ]));
  }

  const again = el('button', { type: 'button', class: 'btn btn-primary', text: 'Nuova sessione' });
  again.addEventListener('click', () => ctx.goTo('config'));
  const exportBtn = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Esporta quiz-errori.json' });
  exportBtn.addEventListener('click', () => ctx.exportLog());
  head.append(el('div', { class: 'actions actions-wrap' }, [again, exportBtn]));
  root.append(head);

  // --- dettaglio MCQ -----------------------------------------------------
  if (mcq.total) {
    root.append(el('h3', { class: 'section-title', text: 'Domande a risposta multipla' }));
    mcq.detail.forEach((d, i) => root.append(questionCard(d, i, ctx)));
  }

  // --- dettaglio flashcard ----------------------------------------------
  if (cards.mcqTotal) {
    root.append(el('h3', { class: 'section-title', text: 'Flashcard a risposta multipla' }));
    cards.detail.filter((c) => c.mode === 'mcq').forEach((c, i) => root.append(cardResultCard(c, i, ctx)));
  }
  if (cards.selfTotal) {
    root.append(el('h3', { class: 'section-title', text: 'Flashcard ad autovalutazione' }));
    root.append(el('section', { class: 'card' }, cards.detail.filter((c) => c.mode === 'self').map((c) => el('details', { class: `result-card ${c.correct ? 'is-ok' : 'is-ko'}` }, [
      el('summary', {}, [
        el('span', { class: `dot ${c.correct ? 'dot-ok' : 'dot-ko'}`, 'aria-hidden': 'true' }),
        el('span', { html: mdInline(c.card.question) }),
      ]),
      el('p', { class: 'muted small', text: `Lezione ${c.card.lesson} — ${c.card.lessonTitle}` }),
      el('div', { class: 'answer', html: mdInline(c.card.answer) }),
    ]))));
  }
}

function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}

function questionCard(d, i, ctx) {
  const q = d.question;
  const state = !d.answered ? 'blank' : d.correct ? 'ok' : 'ko';
  const card = el('section', { class: `card result-question is-${state}` });

  card.append(el('div', { class: 'result-head' }, [
    el('span', { class: `dot dot-${state === 'ok' ? 'ok' : state === 'ko' ? 'ko' : 'blank'}`, 'aria-hidden': 'true' }),
    el('span', { class: 'muted small', text: `${i + 1}. Lezione ${q.lesson} — ${q.lessonTitle} · domanda ${q.number}` }),
  ]));
  card.append(el('p', { class: 'question-text', html: mdInline(q.text) }));

  if (q.platformMismatch) {
    card.append(el('p', { class: 'banner banner-alarm' },
      `🚨 All'esame la piattaforma potrebbe assegnare il punto alla ${q.platformKey}. La risposta conforme alle slide è la ${q.correctKey}.`));
  }

  // opzioni in ordine originale del file
  const list = el('ul', { class: 'options options-static' });
  for (const opt of q.options) {
    const badges = [];
    if (opt.key === q.correctKey) badges.push(el('span', { class: 'tag tag-ok', text: 'corretta (slide)' }));
    if (opt.key === d.givenKey) badges.push(el('span', { class: 'tag tag-mine', text: 'la tua scelta' }));
    if (q.platformMismatch && opt.key === q.platformKey) badges.push(el('span', { class: 'tag tag-alarm', text: 'chiave piattaforma' }));
    const cls = [
      'option',
      opt.key === q.correctKey ? 'option-correct' : '',
      opt.key === d.givenKey && !d.correct ? 'option-wrong' : '',
    ].filter(Boolean).join(' ');
    list.append(el('li', { class: cls }, [
      el('span', { class: 'option-key', text: opt.key }),
      el('span', { class: 'option-text' }, [
        el('span', { html: mdInline(opt.text) }),
        badges.length ? el('span', { class: 'tags' }, badges) : null,
      ]),
    ]));
  }
  card.append(list);

  if (!d.answered) card.append(el('p', { class: 'hint', text: 'Lasciata in bianco.' }));

  for (const ex of q.explanations) {
    card.append(el('p', { class: 'explanation' }, [
      el('strong', { text: `${ex.label}: ` }),
      el('span', { html: mdInline(ex.text) }),
    ]));
  }

  if (q.warning) card.append(el('p', { class: 'banner banner-alarm', html: mdInline(q.warning) }));

  const meta = el('p', { class: 'meta' });
  if (q.sources) meta.append(el('span', { class: 'muted small', text: `Fonti: ${q.sources.raw}` }));
  const noteUrl = ctx.noteUrlFor(q.lesson);
  if (noteUrl) {
    meta.append(el('a', {
      class: 'link', href: noteUrl, target: '_blank', rel: 'noopener',
      text: `Nota della lezione ${q.lesson} ↗`,
    }));
  }
  card.append(meta);

  // suggerimenti di studio solo per le sbagliate/in bianco
  if (!d.correct) {
    const related = ctx.riskCardsForLesson(q.lesson, 6);
    if (related.length) {
      card.append(el('details', { class: 'suggest' }, [
        el('summary', { text: `Da ripassare: ${related.length} flashcard segnate della lezione ${q.lesson}` }),
        el('ul', {}, related.map((c) => el('li', {}, [
          el('span', { class: 'tag tag-warn', text: c.risk === 'alarm' ? '🚨' : '⚠️' }),
          el('span', { html: mdInline(c.question) }),
          el('div', { class: 'muted small', html: mdInline(c.answer) }),
        ]))),
      ]));
    }
  }

  return card;
}

/**
 * Dettaglio di una flashcard giocata a risposta multipla. Non riusa
 * `questionCard()`: quella dipende da `number`, `explanations`, `sources` e
 * dalla chiave della piattaforma, che sulle flashcard non esistono.
 */
function cardResultCard(d, i, ctx) {
  const card = d.card;
  const q = d.item.question;
  const state = d.correct ? 'ok' : 'ko';
  const box = el('section', { class: `card result-question is-${state}` });

  box.append(el('div', { class: 'result-head' }, [
    el('span', { class: `dot dot-${state}`, 'aria-hidden': 'true' }),
    el('span', { class: 'muted small', text: `${i + 1}. Lezione ${card.lesson} — ${card.lessonTitle}` }),
  ]));
  box.append(el('p', { class: 'question-text', html: mdInline(card.question) }));

  // Ordine originale del file: la corretta prima, poi i distrattori.
  const list = el('ul', { class: 'options options-static' });
  for (const opt of q.options) {
    const badges = [];
    if (opt.key === q.correctKey) badges.push(el('span', { class: 'tag tag-ok', text: 'corretta' }));
    if (opt.key === d.givenKey) badges.push(el('span', { class: 'tag tag-mine', text: 'la tua scelta' }));
    const cls = [
      'option',
      opt.key === q.correctKey ? 'option-correct' : '',
      opt.key === d.givenKey && !d.correct ? 'option-wrong' : '',
    ].filter(Boolean).join(' ');
    list.append(el('li', { class: cls }, [
      el('span', { class: 'option-key', text: opt.key }),
      el('span', { class: 'option-text' }, [
        el('span', { html: mdInline(opt.text) }),
        badges.length ? el('span', { class: 'tags' }, badges) : null,
      ]),
    ]));
  }
  box.append(list);

  if (card.risk) {
    box.append(el('p', { class: `banner banner-${card.risk === 'alarm' ? 'alarm' : 'warn'}`, text: card.risk === 'alarm' ? '🚨 attenzione: contenuto insidioso' : '⚠️ punto insidioso' }));
  }
  // La risposta integrale resta il materiale di studio anche quando l'opzione
  // mostrata era la sua forma condensata.
  box.append(el('div', { class: 'answer', html: mdInline(card.answer) }));

  const noteUrl = ctx.noteUrlFor(card.lesson);
  if (noteUrl) {
    box.append(el('p', { class: 'meta' }, [
      el('a', {
        class: 'link', href: noteUrl, target: '_blank', rel: 'noopener',
        text: `Nota della lezione ${card.lesson} ↗`,
      }),
    ]));
  }

  return box;
}
