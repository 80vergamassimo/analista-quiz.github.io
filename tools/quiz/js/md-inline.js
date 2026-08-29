// md-inline.js — renderer markdown "inline" minimale.
//
// Modulo PURO: nessun riferimento a DOM/window, importabile da Node.
//
// Pipeline (nell'ordine): escape HTML -> **grassetto** -> *corsivo* -> `codice`.
// Nient'altro viene interpretato: «caporali», ①②③, trattini lunghi ed emoji
// restano caratteri letterali. L'escaping avviene PRIMA di qualsiasi
// sostituzione, quindi l'unico HTML che può finire nell'output è quello
// generato qui: nessuna iniezione possibile dai file markdown del wiki.

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape di tutti i caratteri significativi per l'HTML. */
export function escapeHtml(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Enfasi e codice su una stringa GIÀ escapata. */
function emphasis(s) {
  // ***grassetto+corsivo*** prima di tutto: altrimenti la coppia esterna di
  // asterischi verrebbe abbinata male e produrrebbe tag incrociati
  // (`<strong><em>…</strong></em>`).
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  // **grassetto** (non greedy, può contenere qualsiasi cosa tranne un altro **)
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  // *corsivo* — solo asterischi singoli rimasti dopo il passaggio precedente
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // `codice`
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s;
}

/**
 * Converte una stringa markdown "inline" in HTML sicuro.
 * @param {string} input
 * @returns {string} HTML già escapato
 */
export function mdInline(input) {
  return emphasis(escapeHtml(input));
}

// Schemi ammessi in un href. Tutto il resto (in primis `javascript:`) viene
// scartato e il link degrada a testo semplice. I percorsi relativi e le ancore
// non hanno schema e passano sempre.
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** @returns {string|null} l'href se accettabile, altrimenti null. */
function safeHref(href) {
  const h = href.trim();
  if (!h) return null;
  if (HAS_SCHEME.test(h) && !SAFE_SCHEME.test(h)) return null;
  return h;
}

/**
 * Come mdInline(), ma riconosce anche i link `[testo](href)`.
 * Serve ai documenti del wiki, che si citano a vicenda; le schermate del quiz
 * usano mdInline(), dove un link sarebbe fuori posto.
 *
 * I link vengono estratti PRIMA dell'enfasi e reinseriti dopo: così un
 * asterisco dentro un URL non viene scambiato per un corsivo, e l'enfasi non
 * può intaccare il markup generato qui.
 *
 * @param {string} input
 * @returns {string} HTML già escapato
 */
export function mdInlineLinks(input) {
  const links = [];
  let s = escapeHtml(input);

  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (_, text, href) => {
    const i = links.push({ text, href }) - 1;
    return `\u0000L${i}\u0000`;
  });

  s = emphasis(s);

  return s.replace(/\u0000L(\d+)\u0000/g, (_, i) => {
    const { text, href } = links[Number(i)];
    const safe = safeHref(href);
    const label = emphasis(text);
    if (!safe) return label;
    const external = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener"' : '';
    return `<a class="link" href="${safe}"${external}>${label}</a>`;
  });
}

/**
 * Rimuove i marcatori markdown restituendo testo semplice (per attributi,
 * title, aria-label…). Non produce HTML.
 */
export function mdStrip(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
