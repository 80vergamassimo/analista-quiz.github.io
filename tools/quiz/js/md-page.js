// md-page.js — bootstrap della pagina di lettura di un markdown del wiki.
//
// Gira dentro md-shell.html, che serve.py restituisce all'URL del file .md
// stesso. Da lì ricava il sorgente da leggere: la stessa URL con `?raw=1`,
// che scavalca il rendering e restituisce il markdown grezzo.

import { parseMarkdown } from './md-doc.js';
import { renderDocument } from './md-render.js';
import { clear, el } from './dom.js';
import { mdStrip } from './md-inline.js';

const out = document.getElementById('doc');
const titleEl = document.getElementById('doc-title');
const pathEl = document.getElementById('doc-path');

/**
 * Separa il titolo dal corpo. L'h1 iniziale è il titolo del documento: diventa
 * l'intestazione della pagina e **non va ripetuto** nel corpo, altrimenti si
 * legge due volte di fila. Se manca si ripiega sul frontmatter, poi sul nome
 * del file.
 * @returns {{title: string, doc: {frontmatter: object|null, blocks: Array}}}
 */
function splitTitle(doc, path) {
  const blocks = [...doc.blocks];
  let title = null;

  if (blocks[0] && blocks[0].type === 'heading' && blocks[0].level === 1) {
    title = mdStrip(blocks.shift().text);
  }
  if (!title && doc.frontmatter && doc.frontmatter.titolo) {
    title = String(doc.frontmatter.titolo);
  }
  if (!title) title = decodeURIComponent(path.split('/').pop() || 'Documento');

  return { title, doc: { frontmatter: doc.frontmatter, blocks } };
}

function fail(message, detail) {
  clear(out);
  out.append(el('p', { class: 'banner banner-error', text: message }));
  if (detail) out.append(el('p', { class: 'hint', text: detail }));
}

async function main() {
  const path = window.location.pathname;
  if (!/\.md$/i.test(path)) {
    fail('Questa pagina mostra i file markdown del wiki.',
      'Aprila da un link a un file .md, oppure torna al simulatore.');
    return;
  }

  pathEl.textContent = decodeURIComponent(path.replace(/^\//, ''));

  const res = await fetch(`${path}?raw=1`, {
    cache: 'no-cache',
    headers: { Accept: 'text/markdown, text/plain' },
  });
  if (!res.ok) {
    fail(`Documento non leggibile (HTTP ${res.status}).`, path);
    return;
  }

  const { title, doc } = splitTitle(parseMarkdown(await res.text()), path);
  document.title = `${title} — Wiki LM-77`;
  titleEl.textContent = title;

  clear(out);
  out.append(renderDocument(doc));

  // L'ancora nell'URL va onorata a mano: il contenuto non esisteva ancora
  // quando il browser ha provato a saltarci.
  if (window.location.hash) {
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target) target.scrollIntoView();
  }
}

main().catch((err) => fail('Errore durante il rendering del documento.', err && err.message));
