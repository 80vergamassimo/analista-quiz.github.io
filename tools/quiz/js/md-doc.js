// md-doc.js — parser markdown di BLOCCO per i documenti del wiki.
//
// Modulo PURO: nessun riferimento a DOM/window, importabile da Node (come
// md-inline.js e i parser di parse-quiz.js / parse-flashcards.js). Trasforma
// il testo in una lista di blocchi dato-puro; a renderizzarli è md-render.js.
//
// Il testo DENTRO i blocchi resta markdown inline: sarà mdInline() a
// convertirlo, così l'escaping resta concentrato in un solo punto.
//
// Costrutti riconosciuti (sono quelli che le note usano davvero):
//   frontmatter YAML · heading · paragrafo · elenco puntato e numerato,
//   annidati · citazione, ricorsiva · tabella GFM · blocco di codice · ---
//
// Volutamente NON riconosciuti: HTML grezzo, note a piè di pagina, liste di
// definizione, immagini (le note non ne contengono).

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)\s*$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_BULLET = /^(\s*)[-*+]\s+(.*)$/;
const RE_ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const RE_COMMENT = /^\s*<!--/;

/**
 * Slug di una heading, usato come id per le ancore e per l'indice.
 * Toglie i marcatori markdown, tiene lettere/cifre accentate, comprime il resto.
 */
export function slugify(text) {
  return String(text || '')
    .replace(/\*\*\*|\*\*|\*|`/g, '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // via i segni diacritici
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sezione';
}

/** Spezza una riga di tabella `| a | b |` nelle sue celle. */
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** Allineamenti dalla riga separatore: 'left' | 'center' | 'right' | null. */
function tableAlign(line) {
  return tableCells(line).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * Frontmatter YAML minimale: `chiave: valore` e liste di `  - voce`.
 * Non è un parser YAML — copre solo la forma usata dalle note del wiki.
 * @returns {{data: object, rest: string[]}}
 */
function takeFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return { data: null, rest: lines };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { data: null, rest: lines };

  const data = {};
  let key = null;
  for (const raw of lines.slice(1, end)) {
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = data[key] ? [data[key]] : [];
      data[key].push(item[1].trim());
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const value = kv[2].trim();
      // `[a, b]` è la forma inline usata dal formato nota documentato in CLAUDE.md
      if (value.startsWith('[') && value.endsWith(']')) {
        data[key] = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        data[key] = value;
      }
    }
  }
  return { data, rest: lines.slice(end + 1) };
}

/**
 * Elenco a partire da `start`. Gli elementi più indentati diventano una lista
 * annidata dentro l'ultimo elemento del livello corrente.
 * @returns {{block: object, next: number}}
 */
function takeList(lines, start) {
  const first = lines[start].match(RE_BULLET) || lines[start].match(RE_ORDERED);
  const baseIndent = first[1].length;
  const ordered = RE_ORDERED.test(lines[start]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const bullet = line.match(RE_BULLET);
    const numbered = line.match(RE_ORDERED);
    const m = bullet || numbered;

    if (!m) {
      // riga vuota: l'elenco continua solo se dopo riprende un elemento
      if (line.trim() === '') {
        const after = lines[i + 1];
        if (after && (RE_BULLET.test(after) || RE_ORDERED.test(after))) { i += 1; continue; }
      }
      break;
    }

    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const nested = takeList(lines, i);
      if (items.length) items[items.length - 1].blocks.push(nested.block);
      i = nested.next;
      continue;
    }
    // un elenco numerato non prosegue un elenco puntato allo stesso livello
    if (!!numbered !== ordered) break;

    items.push({ text: (numbered ? m[3] : m[2]).trim(), blocks: [] });
    i += 1;
  }

  return { block: { type: 'list', ordered, items }, next: i };
}

/**
 * Analizza un documento markdown.
 * @param {string} text
 * @returns {{frontmatter: object|null, blocks: Array<object>}}
 */
export function parseMarkdown(text) {
  const all = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const { data: frontmatter, rest: lines } = takeFrontmatter(all);
  const blocks = [];
  let i = 0;

  // Il testo grezzo dei paragrafi si accumula qui e si scarica al primo blocco
  // di altro tipo o alla prima riga vuota.
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { flush(); i += 1; continue; }

    const fence = line.match(RE_FENCE);
    if (fence) {
      flush();
      const marker = fence[2][0];
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = lines[i].match(RE_FENCE);
        if (close && close[2][0] === marker) { i += 1; break; }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[3] || '', text: body.join('\n') });
      continue;
    }

    // Commenti HTML: note di formato per chi scrive i file, non contenuto. Il
    // corpo va scartato PRIMA di leggerlo come markdown, altrimenti gli `##`
    // dei template diventano sezioni vere e finiscono nell'indice (in
    // domande-esame.md ne entrava una fasulla, «D: <domanda>»).
    //
    // Solo a INIZIO RIGA, di proposito: in CLAUDE.md c'è un
    // `<!-- piano-studi:… -->` dentro un codice inline, che deve restare.
    // Viene dopo il fence, così un commento in un blocco di codice si vede.
    if (RE_COMMENT.test(line)) {
      flush();
      while (i < lines.length && !lines[i].includes('-->')) i += 1;
      i += 1;                                   // la riga che chiude
      continue;
    }

    const heading = line.match(RE_HEADING);
    if (heading) {
      flush();
      const raw = heading[2].replace(/\s+#+\s*$/, '').trim();
      blocks.push({ type: 'heading', level: heading[1].length, text: raw, id: slugify(raw) });
      i += 1;
      continue;
    }

    // `---` è un separatore solo fuori dal frontmatter, che è già stato tolto
    if (RE_HR.test(line)) { flush(); blocks.push({ type: 'hr' }); i += 1; continue; }

    if (RE_QUOTE.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        inner.push(lines[i].match(RE_QUOTE)[1]);
        i += 1;
      }
      // ricorsione: dentro una citazione valgono gli stessi costrutti
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n')).blocks });
      continue;
    }

    // tabella: riga di intestazione seguita dalla riga di separazione
    if (line.trim().includes('|') && lines[i + 1] && RE_TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = tableCells(line);
      const align = tableAlign(lines[i + 1]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', head, align, rows });
      continue;
    }

    if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
      flush();
      const { block, next } = takeList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    para.push(line);
    i += 1;
  }

  flush();
  return { frontmatter, blocks };
}

/**
 * Indice del documento: le heading di livello compreso fra `min` e `max`.
 * @returns {Array<{level: number, text: string, id: string}>}
 */
export function tableOfContents(blocks, min = 2, max = 3) {
  return blocks
    .filter((b) => b.type === 'heading' && b.level >= min && b.level <= max)
    .map(({ level, text, id }) => ({ level, text, id }));
}
