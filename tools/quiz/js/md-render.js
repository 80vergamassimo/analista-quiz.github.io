// md-render.js — dai blocchi di md-doc.js al DOM.
//
// Regola della casa (vedi dom.js): `innerHTML` solo con output di
// mdInline()/mdInlineLinks(), che escapano l'input prima di generare tag. Per
// tutto il resto — testo delle celle, contenuto dei blocchi di codice — si usa
// `text`, cioè textContent.

import { el, frag } from './dom.js';
import { mdInlineLinks, mdStrip } from './md-inline.js';
import { tableOfContents } from './md-doc.js';

// I callout usati dalle note e da CLAUDE.md. La chiave è il primo carattere
// significativo della citazione.
const CALLOUTS = [
  ['🚨', 'quote-alarm'],
  ['⚠️', 'quote-warn'],
  ['ℹ️', 'quote-info'],
];

function calloutClass(blocks) {
  const first = blocks.find((b) => b.type === 'paragraph' || b.type === 'heading');
  const text = first ? String(first.text).trimStart() : '';
  const hit = CALLOUTS.find(([marker]) => text.startsWith(marker));
  return hit ? hit[1] : null;
}

function renderList(block) {
  return el(block.ordered ? 'ol' : 'ul', { class: 'md-list' },
    block.items.map((item) => el('li', {}, [
      el('span', { html: mdInlineLinks(item.text) }),
      ...item.blocks.map(renderBlock),
    ])));
}

function renderTable(block) {
  const cell = (tag, text, align) => el(tag, {
    html: mdInlineLinks(text),
    style: align ? `text-align:${align}` : null,
  });

  // Il wrapper è ciò che scorre in orizzontale: senza, una tabella larga
  // trascinerebbe con sé l'intera pagina.
  return el('div', { class: 'md-table-wrap' }, [
    el('table', { class: 'md-table' }, [
      block.head.length
        ? el('thead', {}, [el('tr', {}, block.head.map((c, i) => cell('th', c, block.align[i])))])
        : null,
      el('tbody', {}, block.rows.map((row) => el('tr', {},
        row.map((c, i) => cell('td', c, block.align[i]))))),
    ]),
  ]);
}

/** @returns {Node} */
export function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return el(`h${Math.min(block.level, 6)}`, {
        id: block.id,
        class: 'md-heading',
        html: mdInlineLinks(block.text),
      });

    case 'paragraph':
      return el('p', { html: mdInlineLinks(block.text) });

    case 'list':
      return renderList(block);

    case 'quote': {
      const cls = calloutClass(block.blocks);
      return el('blockquote', { class: cls ? `md-quote ${cls}` : 'md-quote' },
        block.blocks.map(renderBlock));
    }

    case 'table':
      return renderTable(block);

    case 'code':
      // niente evidenziazione della sintassi: textContent e basta
      return el('pre', { class: 'md-code' }, [el('code', { text: block.text })]);

    case 'hr':
      return el('hr', { class: 'md-hr' });

    default:
      return el('p', { text: String(block.text || '') });
  }
}

/** Intestazione compatta dal frontmatter della nota. */
function renderFrontmatter(data) {
  if (!data) return null;
  const rows = [];
  const add = (label, value) => {
    if (!value) return;
    rows.push(el('div', { class: 'md-meta-row' }, [
      el('span', { class: 'md-meta-key', text: label }),
      el('span', { class: 'md-meta-val', text: Array.isArray(value) ? value.join(' · ') : String(value) }),
    ]));
  };
  add('Esame', data.esame);
  add('Lezione', data.lezione);
  add('Docente', data.docente);
  add('Fonti', data.fonti);
  add('Generata il', data['data-generazione']);
  return rows.length ? el('div', { class: 'md-meta' }, rows) : null;
}

/** Indice richiudibile delle sezioni; null se il documento è corto. */
function renderToc(blocks) {
  const entries = tableOfContents(blocks);
  if (entries.length < 3) return null;
  return el('details', { class: 'md-toc' }, [
    el('summary', { text: `Indice — ${entries.length} sezioni` }),
    el('ul', {}, entries.map((h) => el('li', { class: `md-toc-h${h.level}` }, [
      el('a', { class: 'link', href: `#${h.id}`, text: mdStrip(h.text) }),
    ]))),
  ]);
}

/**
 * Documento completo: intestazione dal frontmatter, indice, blocchi.
 * @param {{frontmatter: object|null, blocks: Array<object>}} doc
 * @returns {DocumentFragment}
 */
export function renderDocument(doc) {
  return frag([
    renderFrontmatter(doc.frontmatter),
    renderToc(doc.blocks),
    ...doc.blocks.map(renderBlock),
  ]);
}
