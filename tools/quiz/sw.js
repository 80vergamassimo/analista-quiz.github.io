// sw.js — cache dell'app nella sola build pubblica (GitHub Pages).
//
// Non si modifica a mano: i tre segnaposto qui sotto sono sostituiti da
// tools/quiz/esporta-pubblico.mjs, che conosce l'elenco esatto dei file
// esportati e ne calcola l'hash.
//
// Perché esiste: la build pubblica è una PWA installabile su Android e iOS, e
// una PWA senza service worker non si installa e non funziona offline. Nel
// repo privato questo file c'è ma NON viene mai registrato — js/app.js lo
// registra solo quando config-pubblico.json dice `pubblico: true`, e quel file
// esiste solo nell'export. La guardia SOSTITUITO qui sotto è la seconda rete:
// se il service worker del repo privato finisse registrato per sbaglio, si
// disinstalla da solo invece di servire un guscio che non gli appartiene.

const VERSIONE = '93052ab28437';
const GUSCIO = [
  "./",
  "./config-pubblico.json",
  "./css/style.css",
  "./icone/apple-touch-icon.png",
  "./icone/icona-192.png",
  "./icone/icona-512.png",
  "./index.html",
  "./js/app.js",
  "./js/discovery.js",
  "./js/dom.js",
  "./js/engine.js",
  "./js/md-doc.js",
  "./js/md-inline.js",
  "./js/md-page.js",
  "./js/md-render.js",
  "./js/parse-flashcards.js",
  "./js/parse-quiz.js",
  "./js/screens/config.js",
  "./js/screens/quiz.js",
  "./js/screens/results.js",
  "./js/storage.js",
  "./js/sync.js",
  "./manifest.webmanifest"
];
const DATI = [
  "./exams.json",
  "../../exams/analisi-dei-mercati-finanziari/flashcards.md",
  "../../exams/analisi-dei-mercati-finanziari/domande-esame.md"
];

// Il confronto è su `__`, non sul token intero: così la sostituzione
// dell'export non riscrive anche il proprio guardiano.
const SOSTITUITO = !VERSIONE.startsWith('__');

// Il guscio è versionato (cambia a ogni pubblicazione), i contenuti no: le
// flashcard sopravvivono ai deploy, e non esiste il caso «guscio nuovo con
// dati di una versione vecchia».
const CACHE_GUSCIO = `lm77-quiz-guscio-${VERSIONE}`;
const CACHE_DATI = 'lm77-quiz-dati';

// I materiali di studio: aggiornati in background, mai bloccanti.
const RE_DATI = /(\.md|\/exams\.json)$/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    if (!SOSTITUITO) { await self.registration.unregister(); return; }
    // addAll è tutto-o-niente: se manca un file del guscio l'install fallisce
    // e resta attivo il service worker precedente. È quello che si vuole.
    const guscio = await caches.open(CACHE_GUSCIO);
    await guscio.addAll(GUSCIO);
    // I contenuti invece sono best-effort: 1,5 MB di flashcard non devono
    // poter impedire l'installazione.
    const dati = await caches.open(CACHE_DATI);
    await Promise.allSettled(DATI.map((u) => dati.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const nome of await caches.keys()) {
      if (nome.startsWith('lm77-quiz-') && nome !== CACHE_GUSCIO && nome !== CACHE_DATI) {
        await caches.delete(nome);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fuori origine (il link PayPal) si va in rete e basta.
  if (url.origin !== self.location.origin) return;

  if (RE_DATI.test(url.pathname)) { e.respondWith(rivalidando(e, req)); return; }
  if (req.mode === 'navigate') { e.respondWith(navigazione(req)); return; }
  e.respondWith(gusciaPrima(req));
});

/**
 * Stale-while-revalidate per i materiali di studio: si risponde subito con la
 * copia in cache e si aggiorna in sottofondo, così i contenuti nuovi arrivano
 * al secondo caricamento.
 *
 * discovery.js chiede i .md con `cache: 'no-cache'`: dentro il service worker
 * questo forza la richiesta di rete a essere condizionale, cioè esattamente il
 * ramo «revalidate» — non va contrastato. `caches.match()` non ne risente.
 */
async function rivalidando(e, req) {
  const cache = await caches.open(CACHE_DATI);
  // ignoreVary: l'app manda un Accept suo, e un Vary del server basterebbe a
  // far fallire il lookup.
  const salvata = await cache.match(req, { ignoreVary: true });
  const rete = fetch(req)
    .then((res) => {
      // cache.put rigetta sulle risposte opache e sui non-2xx: la guardia è
      // obbligatoria, non difensiva.
      if (res && res.ok && res.status === 200) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  // Senza questo la rivalidazione può essere uccisa con l'evento.
  e.waitUntil(rete);
  return salvata || (await rete) || Response.error();
}

/** Navigazioni: rete, e offline la index del guscio. */
async function navigazione(req) {
  try {
    const res = await fetch(req);
    if (res) return res;
  } catch (err) { /* offline */ }
  const guscio = await caches.open(CACHE_GUSCIO);
  return (await guscio.match('./index.html', { ignoreVary: true })) || Response.error();
}

/**
 * Il resto dell'app shell: cache prima, rete come ripiego. Non si scrive nulla
 * di nuovo nella cache versionata — che cosa sta nel guscio lo decide solo
 * l'export.
 */
async function gusciaPrima(req) {
  const guscio = await caches.open(CACHE_GUSCIO);
  const salvata = await guscio.match(req, { ignoreVary: true });
  if (salvata) return salvata;
  try {
    return await fetch(req);
  } catch (err) {
    return Response.error();
  }
}
