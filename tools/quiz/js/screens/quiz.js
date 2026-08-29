// screens/quiz.js — svolgimento della sessione.
//
// Due blocchi separati, mai intercalati:
//  1) tutte le MCQ, con navigazione libera avanti/indietro, griglia numerata
//     e consegna esplicita (come le piattaforme d'esame reali);
//  2) le flashcard, sequenziali e senza ritorno indietro. Quelle con distrattori
//     curati si giocano a risposta multipla: la scelta è revocabile finché non
//     si conferma, poi il feedback è immediato (è un drill, non l'esame). Le
//     altre restano ad autovalutazione (che non è onestamente revocabile).

import { el, clear } from '../dom.js';
import { mdInline } from '../md-inline.js';

/**
 * Promemoria del filtro attivo: senza, una prova corta su due lezioni sembra
 * una prova sull'intero esame andata male.
 */
function lessonBadge(s) {
  if (!s.lessons || !s.lessons.length) return null;
  return el('span', { class: 'muted', text: `Lezioni ${s.lessons.join(', ')}` });
}

export function renderQuiz(root, ctx) {
  clear(root);
  const s = ctx.state.session;
  if (!s) { ctx.goTo('config'); return; }
  if (s.phase === 'mcq') renderMcq(root, ctx, s);
  else renderCard(root, ctx, s);
}

/**
 * Ogni interazione ridisegna la schermata, quindi il fuoco della tastiera
 * andrebbe perso: `s.focus` ricorda su cosa era e lo ripristina dopo il
 * ridisegno. Senza questo, chi naviga da tastiera torna a inizio pagina a
 * ogni risposta.
 */
function restoreFocus(s, targets) {
  if (!s.focus) return;
  let node = targets[`${s.focus.kind}:${s.focus.ref}`];
  // ai bordi la freccia usata diventa disabilitata: si ripiega sull'altra
  if (node && node.disabled && s.focus.kind === 'nav') {
    node = targets[s.focus.ref === 'prev' ? 'nav:next' : 'nav:prev'];
  }
  if (node && !node.disabled && typeof node.focus === 'function') node.focus();
}

// ---------------------------------------------------------------------------
// Blocco MCQ
// ---------------------------------------------------------------------------

function renderMcq(root, ctx, s) {
  const item = s.mcqItems[s.index];
  const q = item.question;
  const total = s.mcqItems.length;
  const answered = s.mcqItems.filter((it) => s.answers[it.question.id]).length;

  root.append(el('div', { class: 'toolbar' }, [
    el('span', { class: 'badge', text: s.mode === 'review' ? 'Ripasso errori' : 'Simulazione' }),
    el('span', { class: 'muted', text: `Domanda ${s.index + 1} di ${total}` }),
    el('span', { class: 'muted', text: `${answered}/${total} risposte` }),
    lessonBadge(s),
  ]));

  root.append(el('div', {
    class: 'progress', role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(answered),
  }, [el('div', { class: 'progress-bar', style: `width:${total ? (answered / total) * 100 : 0}%` })]));

  const card = el('section', { class: 'card question-card' });
  card.append(el('p', { class: 'muted small', text: `Lezione ${q.lesson} — ${q.lessonTitle}` }));
  card.append(el('h2', { class: 'question-text', html: mdInline(q.text) }));

  const targets = {};
  const list = el('div', { class: 'options', role: 'group', 'aria-label': 'Opzioni di risposta' });
  for (const opt of item.options) {
    const chosen = s.answers[q.id] === opt.key;
    const btn = el('button', {
      type: 'button',
      class: `option${chosen ? ' option-selected' : ''}`,
      'aria-pressed': chosen ? 'true' : 'false',
      dataset: { key: opt.key },
    }, [
      el('span', { class: 'option-key', text: opt.key }),
      el('span', { class: 'option-text', html: mdInline(opt.text) }),
    ]);
    targets[`option:${opt.key}`] = btn;
    btn.addEventListener('click', () => {
      s.answers[q.id] = s.answers[q.id] === opt.key ? null : opt.key;
      if (!s.answers[q.id]) delete s.answers[q.id];
      s.focus = { kind: 'option', ref: opt.key };
      ctx.rerender();
    });
    list.append(btn);
  }
  card.append(list);
  root.append(card);

  // navigazione
  const prev = el('button', { type: 'button', class: 'btn btn-ghost', text: '← Precedente', disabled: s.index === 0 });
  prev.addEventListener('click', () => { s.index = Math.max(0, s.index - 1); s.focus = { kind: 'nav', ref: 'prev' }; ctx.rerender(); });
  const next = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Successiva →', disabled: s.index >= total - 1 });
  next.addEventListener('click', () => { s.index = Math.min(total - 1, s.index + 1); s.focus = { kind: 'nav', ref: 'next' }; ctx.rerender(); });
  targets['nav:prev'] = prev;
  targets['nav:next'] = next;
  root.append(el('div', { class: 'actions actions-split' }, [prev, next]));

  // griglia numerata
  const grid = el('div', { class: 'grid', role: 'group', 'aria-label': 'Vai alla domanda' });
  s.mcqItems.forEach((it, i) => {
    const done = !!s.answers[it.question.id];
    const b = el('button', {
      type: 'button',
      class: `grid-cell${done ? ' is-answered' : ''}${i === s.index ? ' is-current' : ''}`,
      text: String(i + 1),
      'aria-label': `Domanda ${i + 1}${done ? ', risposta data' : ', in bianco'}`,
      'aria-current': i === s.index ? 'true' : null,
    });
    targets[`grid:${i}`] = b;
    b.addEventListener('click', () => { s.index = i; s.focus = { kind: 'grid', ref: i }; ctx.rerender(); });
    grid.append(b);
  });
  root.append(el('section', { class: 'card' }, [
    el('h3', { class: 'small', text: 'Riepilogo risposte' }),
    grid,
    el('p', { class: 'hint', text: 'Le celle piene sono le domande a cui hai risposto. Puoi tornare su qualsiasi domanda prima di consegnare.' }),
  ]));

  const submit = el('button', { type: 'button', class: 'btn btn-primary btn-block', text: 'Consegna' });
  submit.addEventListener('click', () => {
    const blank = total - answered;
    if (blank > 0) {
      const msg = blank === 1
        ? 'È rimasta 1 domanda in bianco. Consegnare comunque?'
        : `Sono rimaste ${blank} domande in bianco. Consegnare comunque?`;
      if (!window.confirm(msg)) return;
    }
    ctx.submitMcq();
  });
  const abort = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Abbandona' });
  abort.addEventListener('click', () => {
    if (window.confirm('Abbandonare la sessione? I risultati non verranno registrati.')) ctx.abortSession();
  });
  root.append(el('div', { class: 'actions actions-wrap' }, [submit, abort]));

  ctx.setKeys((ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toUpperCase();
    const byLetter = item.options.find((o) => o.key === k);
    const byNumber = /^[1-9]$/.test(k) ? item.options[Number(k) - 1] : null;
    const chosen = byLetter || byNumber;
    if (chosen) {
      ev.preventDefault();
      s.answers[q.id] = chosen.key;
      s.focus = { kind: 'option', ref: chosen.key };
      ctx.rerender();
      return;
    }
    if (ev.key === 'ArrowRight' && s.index < total - 1) { ev.preventDefault(); s.index++; s.focus = null; ctx.rerender(); }
    if (ev.key === 'ArrowLeft' && s.index > 0) { ev.preventDefault(); s.index--; s.focus = null; ctx.rerender(); }
  });

  restoreFocus(s, targets);
}

// ---------------------------------------------------------------------------
// Blocco flashcard
// ---------------------------------------------------------------------------

const RISK_LABEL = { warn: '⚠️ punto insidioso', alarm: '🚨 attenzione: contenuto insidioso' };

function renderCard(root, ctx, s) {
  const card = s.cards[s.cardIndex];
  const item = s.cardItems ? s.cardItems[s.cardIndex] : null;
  const total = s.cards.length;
  const done = Object.values(s.cardResults).filter((r) => r && r.correct).length;

  root.append(el('div', { class: 'toolbar' }, [
    el('span', { class: 'badge', text: 'Flashcard' }),
    el('span', { class: 'muted', text: `Card ${s.cardIndex + 1} di ${total}` }),
    el('span', { class: 'muted', text: `${done} ok` }),
    lessonBadge(s),
  ]));

  root.append(el('div', {
    class: 'progress', role: 'progressbar',
    'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(s.cardIndex),
  }, [el('div', { class: 'progress-bar', style: `width:${total ? (s.cardIndex / total) * 100 : 0}%` })]));

  const box = el('section', { class: 'card question-card' });
  box.append(el('p', { class: 'muted small', text: `Lezione ${card.lesson} — ${card.lessonTitle}` }));
  // Nel percorso a risposta multipla il banner di rischio arriva DOPO la
  // risposta (vedi renderCardMcq): annunciare «punto insidioso» prima di
  // rispondere regalerebbe metà informazione.
  if (card.risk && !item) box.append(riskBanner(card));
  box.append(el('h2', { class: 'question-text', html: mdInline(card.question) }));

  const focusMe = item
    ? renderCardMcq(box, ctx, s, card, item)
    : renderCardSelf(box, ctx, s, card);

  root.append(box);
  // Il fuoco segue il passo successivo: rispondi/rivela → avanza.
  if (focusMe && typeof focusMe.focus === 'function') focusMe.focus();

  root.append(el('p', { class: 'hint', text: 'Le flashcard sono sequenziali: una volta risposto, non si torna indietro.' }));
}

function riskBanner(card) {
  return el('p', {
    class: `banner banner-${card.risk === 'alarm' ? 'alarm' : 'warn'}`,
    text: RISK_LABEL[card.risk],
  });
}

/** Percorso storico: rivela la risposta e chiedi un giudizio a chi studia. */
function renderCardSelf(box, ctx, s, card) {
  if (!s.cardRevealed) {
    const reveal = el('button', { type: 'button', class: 'btn btn-primary btn-block', text: 'Mostra risposta' });
    reveal.addEventListener('click', () => { s.cardRevealed = true; ctx.rerender(); });
    box.append(reveal);
    ctx.setKeys((ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); s.cardRevealed = true; ctx.rerender(); }
    });
    return reveal;
  }

  box.append(el('div', { class: 'answer', html: mdInline(card.answer) }));
  const yes = el('button', { type: 'button', class: 'btn btn-primary', text: 'La sapevo' });
  const no = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Non la sapevo' });
  yes.addEventListener('click', () => ctx.answerCard(true));
  no.addEventListener('click', () => ctx.answerCard(false));
  box.append(el('div', { class: 'actions actions-split' }, [no, yes]));
  ctx.setKeys((ev) => {
    if (ev.key === '1' || ev.key.toLowerCase() === 'n') { ev.preventDefault(); ctx.answerCard(false); }
    if (ev.key === '2' || ev.key.toLowerCase() === 's') { ev.preventDefault(); ctx.answerCard(true); }
  });
  return no;
}

/**
 * Percorso a risposta multipla, in due passi come il blocco MCQ: si sceglie
 * un'opzione (revocabile: ri-cliccarla la deseleziona) e si conferma. Il
 * banner di rischio compare **solo dopo** la conferma: annunciare «punto
 * insidioso» prima regalerebbe metà informazione.
 */
function renderCardMcq(box, ctx, s, card, item) {
  const res = s.cardAnswered ? s.cardResults[card.id] : null;
  const correctKey = (item.options.find((o) => o.origKey === item.question.correctKey) || {}).key;
  const chosenKey = res ? null : s.cardChoice;

  const list = el('div', {
    class: `options${res ? ' options-static' : ''}`,
    role: 'group',
    'aria-label': 'Opzioni di risposta',
  });
  for (const opt of item.options) {
    let cls = 'option';
    if (res) {
      if (opt.key === correctKey) cls += ' option-correct';
      else if (opt.key === res.displayKey) cls += ' option-wrong';
    } else if (opt.key === chosenKey) {
      cls += ' option-selected';
    }
    const btn = el('button', {
      type: 'button',
      class: cls,
      disabled: !!res,
      'aria-pressed': res ? null : (opt.key === chosenKey ? 'true' : 'false'),
      dataset: { key: opt.key },
    }, [
      el('span', { class: 'option-key', text: opt.key }),
      el('span', { class: 'option-text', html: mdInline(opt.text) }),
    ]);
    if (!res) btn.addEventListener('click', () => ctx.chooseCardMcq(opt.key));
    list.append(btn);
  }
  box.append(list);

  if (!res) {
    const confirm = el('button', {
      type: 'button',
      class: 'btn btn-primary btn-block',
      text: 'Conferma risposta',
      disabled: !chosenKey,
    });
    confirm.addEventListener('click', () => ctx.answerCardMcq());
    box.append(confirm);
    box.append(el('p', {
      class: 'hint',
      text: chosenKey
        ? 'Puoi ancora cambiare opzione: l\'esito compare solo dopo la conferma.'
        : 'Scegli un\'opzione, poi conferma.',
    }));
    ctx.setKeys((ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        if (!s.cardChoice) return;
        ev.preventDefault();
        ctx.answerCardMcq();
        return;
      }
      const k = ev.key.toUpperCase();
      if (item.options.some((o) => o.key === k)) { ev.preventDefault(); ctx.chooseCardMcq(k); return; }
      const n = Number(ev.key);
      if (n >= 1 && n <= item.options.length) { ev.preventDefault(); ctx.chooseCardMcq(item.options[n - 1].key); }
    });
    // Il fuoco segue il passo successivo: senza scelta è la prima opzione, con
    // una scelta fatta è la conferma — così `Invio` chiude la card senza che
    // chi naviga da tastiera debba cercare il bottone.
    return chosenKey ? confirm : list.querySelector('button');
  }

  box.append(el('p', { class: `banner banner-${res.correct ? 'ok' : 'error'}`, text: res.correct ? '✅ Risposta corretta' : '❌ Risposta sbagliata' }));
  if (card.risk) box.append(riskBanner(card));
  // La risposta integrale è il materiale di studio: l'opzione condensata non
  // deve sostituirla nel momento in cui si impara dall'errore.
  box.append(el('div', { class: 'answer', html: mdInline(card.answer) }));

  const next = el('button', { type: 'button', class: 'btn btn-primary btn-block', text: s.cardIndex + 1 >= s.cards.length ? 'Vedi il riepilogo' : 'Avanti →' });
  next.addEventListener('click', () => ctx.advanceCard());
  box.append(next);
  ctx.setKeys((ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ctx.advanceCard(); }
  });
  return next;
}
