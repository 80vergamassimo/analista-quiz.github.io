// sw.js — cache dell'app nella sola build pubblica (GitHub Pages).
//
// Non si modifica a mano: i quattro segnaposto qui sotto sono sostituiti da
// tools/quiz/esporta-pubblico.mjs, che conosce l'elenco esatto dei file
// esportati e ne calcola l'hash. Nel repo privato questo file sta in
// tools/quiz/, ma l'export lo scrive nella RADICE del sito: uno script di
// radice è l'unico che può avere scope `/` e quindi coprire anche la pagina
// di rimbalzo della radice — che è quella che iOS installa se si aggiunge
// alla schermata Home da «lm77-quiz.github.io» invece che da «…/tools/quiz/».
// I percorsi di GUSCIO e DATI sono quindi relativi alla radice del sito.
//
// Perché esiste: la build pubblica è una PWA installabile su Android e iOS, e
// una PWA senza service worker non si installa e non funziona offline. Nel
// repo privato questo file c'è ma NON viene mai registrato — js/app.js lo
// registra solo quando config-pubblico.json dice `pubblico: true`, e quel file
// esiste solo nell'export. La guardia SOSTITUITO qui sotto è la seconda rete:
// se il service worker del repo privato finisse registrato per sbaglio, si
// disinstalla da solo invece di servire un guscio che non gli appartiene.

const VERSIONE = 'b5563e808d0e';
const GUSCIO = [
  "./",
  "./index.html",
  "./tools/quiz/",
  "./tools/quiz/config-pubblico.json",
  "./tools/quiz/css/style.css",
  "./tools/quiz/icone/apple-touch-icon.png",
  "./tools/quiz/icone/icona-192.png",
  "./tools/quiz/icone/icona-512.png",
  "./tools/quiz/index.html",
  "./tools/quiz/js/app.js",
  "./tools/quiz/js/discovery.js",
  "./tools/quiz/js/dom.js",
  "./tools/quiz/js/engine.js",
  "./tools/quiz/js/md-doc.js",
  "./tools/quiz/js/md-inline.js",
  "./tools/quiz/js/md-page.js",
  "./tools/quiz/js/md-render.js",
  "./tools/quiz/js/parse-flashcards.js",
  "./tools/quiz/js/parse-quiz.js",
  "./tools/quiz/js/screens/config.js",
  "./tools/quiz/js/screens/quiz.js",
  "./tools/quiz/js/screens/results.js",
  "./tools/quiz/js/storage.js",
  "./tools/quiz/js/sync.js",
  "./tools/quiz/manifest.webmanifest"
];
const DATI = [
  "./tools/quiz/exams.json",
  "./exams/analisi-dei-mercati-finanziari/flashcards.md",
  "./exams/analisi-dei-mercati-finanziari/domande-esame.md"
];
// Dove sta l'app vera: è il ripiego di ogni navigazione che non si trova.
const APP = './tools/quiz/index.html';

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

/**
 * Navigazioni: prima la cache, poi la rete, e in ultimo l'app.
 *
 * Cache prima e non rete prima perché è ciò che fa partire l'app installata
 * senza rete, che è tutto il punto della PWA; i contenuti nuovi arrivano lo
 * stesso, perché il browser rilegge sw.js a ogni navigazione e un export
 * nuovo ne cambia l'hash, quindi il guscio si rinnova al giro dopo.
 *
 * Il ripiego finale è l'index dell'APP, non quella della radice: la radice è
 * solo un rimbalzo, e servirla come ripiego per una navigazione dentro l'app
 * la farebbe ripartire dal principio.
 */
async function navigazione(req) {
  const guscio = await caches.open(CACHE_GUSCIO);
  const salvata = await guscio.match(req, { ignoreVary: true });
  if (salvata) return salvata;
  try {
    const res = await fetch(req);
    if (res) return res;
  } catch (err) { /* offline */ }
  return (await guscio.match(APP, { ignoreVary: true })) || Response.error();
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
