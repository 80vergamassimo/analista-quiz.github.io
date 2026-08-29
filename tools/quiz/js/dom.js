// dom.js — micro-helper per costruire il DOM senza inline script/handler.
//
// Regole della casa (CSP-safe):
//  - nessun attributo on* nell'HTML: i listener si attaccano solo via addEventListener;
//  - `innerHTML` si usa SOLO con stringhe prodotte da mdInline() di md-inline.js,
//    che escapa l'input prima di generare i tag. Per tutto il resto: textContent.

/**
 * @param {string} tag
 * @param {object} [attrs] classi, attributi, `text` (textContent), `html` (già escapato)
 * @param {Array} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // solo output di mdInline()
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function frag(children) {
  const f = document.createDocumentFragment();
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    f.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return f;
}
