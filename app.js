// Kitob Skaner — brauzerda kamera orqali sahifalarni nusxalab, PDF qilib beradi.

const $ = (s) => document.querySelector(s);
const app = $('#app'), video = $('#video'), overlay = $('#overlay'), result = $('#result');
const msg = $('#msg'), progress = $('#progress');

const MAX_DIM = 2200;            // olingan rasmning eng katta tomoni
const DETECT_W = 480;            // sahifani topish uchun kichik kadr eni
const AUTO_STABLE_MS = 1300;     // avto-olish: sahifa shuncha qimirlamasa
const AUTO_COOLDOWN_MS = 2500;
const JPEG_Q = 0.82;
const THUMB_DIM = 360;           // galereyadagi kichik rasm o'lchami

let cvReady = false;
let stream = null, facing = 'environment';
let mode = 'gray';
// Ikki bo'lim: "image" — rasm PDF, "text" — sahifadagi matn o'qib olinib, matnli PDF
let section = 'image';
const books = { image: [], text: [] };
const pdfs = { image: null, text: null };
let pages = books.image;         // joriy bo'lim sahifalari: {id, w, h, img, th, [text, status, lang]} (img/th — rasm kalitlari)
let raw = null, rawQuad = null, rotation = 0, current = null;
let lastQuad = null, prevQuad = null, stableSince = 0, cooldownUntil = 0;
let lastPdf = null;               // arxivdagi oxirgi PDF
let archive = [];                 // {id, name, date, section, pdfKey, size, pages: [{w, h, img, th, text}]}

// ---------------------------------------------------------------- OpenCV
async function onOpenCvLoaded() {
  try {
    if (window.cv instanceof Promise) window.cv = await window.cv;
  } catch (e) { onOpenCvFailed(); return; }
  // WebAssembly ishga tushguncha kutamiz
  const started = Date.now();
  (function wait() {
    if (window.cv && window.cv.Mat) cvLoaded();
    else if (Date.now() - started > 60000) onOpenCvFailed();
    else setTimeout(wait, 150);
  })();
}
function cvLoaded() {
  if (cvReady) return;
  cvReady = true;
  if (msg.dataset.kind === 'cv') setMsg('');
}
function onOpenCvFailed() {
  toast("Sahifani kesish moduli yuklanmadi — rasm butunligicha olinadi");
}
window.onOpenCvLoaded = onOpenCvLoaded;
window.onOpenCvFailed = onOpenCvFailed;

// ---------------------------------------------------------------- Kamera
async function startCamera() {
  stopCamera();
  setMsg('Kamera ochilmoqda…');
  if (!navigator.mediaDevices?.getUserMedia) {
    setMsg('Bu brauzer kamerani qo‘llab-quvvatlamaydi. Chrome yoki Safari’da oching.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play();
    if (cvReady) setMsg('');
    else { setMsg('Ishlov berish moduli yuklanmoqda…'); msg.dataset.kind = 'cv'; }
  } catch (e) {
    msg.dataset.kind = '';
    msg.innerHTML = 'Kameraga ruxsat berilmadi.<br>Brauzer manzil satridagi 🔒 belgisidan kameraga ruxsat bering.' +
      '<br><button class="btn green" id="retryCam">Qayta urinish</button>';
    $('#retryCam').onclick = startCamera;
  }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---------------------------------------------------------------- Rasmga ishlov berish
function orderPoints(p) {
  // yuqori-chap, yuqori-o'ng, past-o'ng, past-chap
  const s = p.map(([x, y]) => x + y), d = p.map(([x, y]) => y - x);
  const at = (arr, fn) => p[arr.indexOf(fn(...arr))];
  return [at(s, Math.min), at(d, Math.min), at(s, Math.max), at(d, Math.max)];
}

function detectQuad(source, sw, sh) {
  if (!cvReady) return null;
  const scale = DETECT_W / sw, h = Math.round(sh * scale);
  const c = detectQuad.canvas || (detectQuad.canvas = document.createElement('canvas'));
  c.width = DETECT_W; c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, DETECT_W, h);

  const src = cv.imread(c), gray = new cv.Mat(), edges = new cv.Mat();
  const k3 = cv.Mat.ones(3, 3, cv.CV_8U), k5 = cv.Mat.ones(5, 5, cv.CV_8U);
  const contours = new cv.MatVector(), hier = new cv.Mat();
  let quad = null;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 50, 150);
    cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 2);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k5);
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const list = [];
    for (let i = 0; i < contours.size(); i++) list.push([i, cv.contourArea(contours.get(i))]);
    list.sort((a, b) => b[1] - a[1]);
    for (const [i, area] of list.slice(0, 5)) {
      if (area < DETECT_W * h * 0.15) break;
      const cnt = contours.get(i), approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const d = approx.data32S;
        quad = orderPoints([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]])
          .map(([x, y]) => [x / scale, y / scale]);
      }
      approx.delete();
      if (quad) break;
    }
  } finally {
    [src, gray, edges, k3, k5, contours, hier].forEach((m) => m.delete());
  }
  return quad;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function warp(src, q) {
  const [tl, tr, br, bl] = q;
  const w = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const h = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
  const M = cv.getPerspectiveTransform(from, to);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  // Chetdagi stol/soya qoldiqlarini olib tashlash
  const mx = Math.round(w * 0.015), my = Math.round(h * 0.015);
  const roi = out.roi(new cv.Rect(mx, my, w - 2 * mx, h - 2 * my));
  const cropped = roi.clone();
  [from, to, M, out, roi].forEach((m) => m.delete());
  return cropped;
}

function normalizeLight(gray) {
  // Fonni (qog'oz yorug'ligini) kichik nusxada hisoblab, keyin unga bo'lamiz
  const small = new cv.Mat(), bg = new cv.Mat(), out = new cv.Mat();
  const f = 0.25;
  cv.resize(gray, small, new cv.Size(0, 0), f, f, cv.INTER_AREA);
  const k = Math.max(15, Math.floor(Math.min(small.cols, small.rows) / 12) | 1);
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
  cv.morphologyEx(small, small, cv.MORPH_CLOSE, kernel);
  cv.GaussianBlur(small, small, new cv.Size(k, k), 0);
  cv.resize(small, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
  cv.divide(gray, bg, out, 255);
  cv.normalize(out, out, 0, 255, cv.NORM_MINMAX);
  [small, bg, kernel].forEach((m) => m.delete());
  return out;
}

function enhance(rgba, m) {
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  if (m === 'color') {
    const lab = new cv.Mat(), ch = new cv.MatVector(), blur = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    cv.split(lab, ch);
    const l = ch.get(0), clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(l, l);
    ch.set(0, l);
    cv.merge(ch, lab);
    cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
    cv.GaussianBlur(rgb, blur, new cv.Size(0, 0), 2);
    cv.addWeighted(rgb, 1.5, blur, -0.5, 0, rgb);
    [lab, ch, blur, l, clahe].forEach((x) => x.delete());
    return rgb;
  }
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  rgb.delete();
  const clean = normalizeLight(gray);
  gray.delete();
  if (m === 'gray') return clean;
  const bw = new cv.Mat();
  cv.adaptiveThreshold(clean, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 15);
  clean.delete();
  return bw;
}

function processPage() {
  const out = document.createElement('canvas');
  if (cvReady) {
    const src = cv.imread(raw);
    const page = rawQuad ? warp(src, rawQuad) : src.clone();
    // Matn bo'limida OCR uchun eng yaxshi natija beradigan "kulrang" rejim
    const done = enhance(page, section === 'text' ? 'gray' : mode);
    cv.imshow(out, done);
    [src, page, done].forEach((m) => m.delete());
  } else {
    out.width = raw.width; out.height = raw.height;
    out.getContext('2d').drawImage(raw, 0, 0);
  }
  return rotate(out, rotation);
}

function rotate(canvas, times) {
  let c = canvas;
  for (let i = 0; i < times; i++) {
    const r = document.createElement('canvas');
    r.width = c.height; r.height = c.width;
    const ctx = r.getContext('2d');
    ctx.translate(r.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(c, 0, 0);
    c = r;
  }
  return c;
}

// ---------------------------------------------------------------- Jonli ko'rinish
function videoBox() {
  // object-fit: contain bo'lganda video ekranda qayerda turganini hisoblaydi
  const ew = overlay.clientWidth, eh = overlay.clientHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(ew / vw, eh / vh);
  return { s, x: (ew - vw * s) / 2, y: (eh - vh * s) / 2, ew, eh };
}

function drawOverlay(quad) {
  const dpr = window.devicePixelRatio || 1;
  const b = videoBox();
  overlay.width = b.ew * dpr; overlay.height = b.eh * dpr;
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, b.ew, b.eh);
  if (!quad) return;
  const pts = quad.map(([x, y]) => [b.x + x * b.s, b.y + y * b.s]);
  ctx.fillStyle = 'rgba(60, 220, 90, 0.18)';
  ctx.strokeStyle = '#3cdc5a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#3cdc5a';
  pts.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); });
}

function liveLoop() {
  if (app.dataset.state === 'live' && video.readyState >= 2 && video.videoWidth) {
    lastQuad = detectQuad(video, video.videoWidth, video.videoHeight);
    drawOverlay(lastQuad);
    handleAuto(lastQuad);
  }
  setTimeout(liveLoop, 150);
}

function handleAuto(quad) {
  const now = performance.now();
  if (!$('#auto').checked || now < cooldownUntil || !quad) {
    stableSince = 0; prevQuad = null; progress.style.width = '0';
    return;
  }
  const moved = !prevQuad ||
    Math.max(...quad.map((p, i) => dist(p, prevQuad[i]))) > video.videoWidth * 0.012;
  prevQuad = quad;
  if (moved || !stableSince) { stableSince = now; progress.style.width = '0'; return; }
  const held = now - stableSince;
  progress.style.width = Math.min(100, (held / AUTO_STABLE_MS) * 100) + '%';
  if (held >= AUTO_STABLE_MS) { stableSince = 0; capture(); }
}


// ---------------------------------------------------------------- Saqlash (sahifa yangilansa ham yo'qolmaydi)
// Har bir rasm IndexedDB'da bir marta, o'z kaliti bilan yoziladi. Ro'yxatlarda faqat
// kichik ma'lumot (kalit, o'lcham, matn) turadi — 500 sahifada ham saqlash tez qoladi.
const store = {
  db: null,
  async open() {
    if (this.db || !window.indexedDB) return this.db;
    this.db = await new Promise((ok, fail) => {
      const req = indexedDB.open('kitob-skaner', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    }).catch(() => null);
    return this.db;
  },
  async run(name, fn, mode = 'readwrite') {
    const db = await this.open();
    if (!db) return null;
    return new Promise((ok) => {
      const tx = db.transaction(name, mode), req = fn(tx.objectStore(name));
      tx.oncomplete = () => ok(req && req.result);
      tx.onerror = tx.onabort = () => ok(null);
    });
  },
  get(key) { return this.run('kv', (s) => s.get(key), 'readonly'); },
  put(key, val) { return this.run('kv', (s) => s.put(val, key)); },
  del(key) { return this.run('kv', (s) => s.delete(key)); },
  async putBlob(blob) {
    const key = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await this.run('blobs', (s) => s.put(blob, key));
    return key;
  },
  getBlob(key) { return this.run('blobs', (s) => s.get(key), 'readonly'); },

  saveList(sec = section) {
    const list = books[sec].map(({ id, w, h, img, th, text, status, lang }) =>
      ({ id, w, h, img, th, text, lang, status: status === 'working' ? 'pending' : status }));
    return this.put('list:' + sec, list);
  },
  loadList(sec) { return this.get('list:' + sec); },
  saveArchive() { return this.put('archive2', archive); },
  loadArchive() { return this.get('archive2'); },

  // Hech qayerda ishlatilmay qolgan rasmlarni o'chiradi
  async gc() {
    const used = new Set();
    const mark = (p) => { used.add(p.img); used.add(p.th); };
    books.image.forEach(mark); books.text.forEach(mark);
    archive.forEach((e) => { used.add(e.pdfKey); e.pages.forEach(mark); });
    const keys = (await this.run('blobs', (s) => s.getAllKeys(), 'readonly')) || [];
    const dead = keys.filter((k) => !used.has(k));
    if (dead.length) await this.run('blobs', (s) => { dead.forEach((k) => s.delete(k)); return null; });
    dead.forEach(forgetUrl);
  },

  // Eski versiyada rasmlar ro'yxat ichida saqlangan edi — yangi tuzilmaga o'tkazamiz
  async migrate() {
    for (const [oldKey, sec] of [['pages', 'image'], ['textPages', 'text']]) {
      const old = await this.get(oldKey);
      if (!old) continue;
      for (const p of old) {
        const { img, th } = await this.saveImages(p.blob);
        books[sec].push({ id: p.id, w: p.w, h: p.h, img, th, text: p.text, status: p.status });
      }
      await this.saveList(sec);
      await this.del(oldKey);
    }
    const oldArchive = await this.get('archive');
    if (oldArchive) {
      for (const e of oldArchive) {
        const pg = [];
        for (const p of e.pages) {
          const { img, th } = await this.saveImages(p.blob);
          pg.push({ w: p.w, h: p.h, img, th, text: p.text });
        }
        archive.push({ id: e.id, name: e.name, date: e.date, section: e.section,
          pdfKey: await this.putBlob(e.pdf), size: e.pdf.size, pages: pg });
      }
      await this.saveArchive();
      await this.del('archive');
    }
  },
  async saveImages(blob) {
    const thumb = await makeThumb(blob);
    return { img: await this.putBlob(blob), th: await this.putBlob(thumb) };
  },
};

async function makeThumb(source) {
  const bmp = await createImageBitmap(source);
  const s = Math.min(1, THUMB_DIM / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.72));
}

// Kichik rasmlar uchun URL kesh
const urlCache = new Map();
async function urlFor(key) {
  if (urlCache.has(key)) return urlCache.get(key);
  const blob = await store.getBlob(key);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}
function forgetUrl(key) {
  const u = urlCache.get(key);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(key); }
}

// Ko'rinadigan joyga kelgan rasmlarnigina yuklaydi (500 sahifada ham galereya tez ochiladi)
const lazy = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const img = en.target;
    lazy.unobserve(img);
    urlFor(img.dataset.key).then((u) => { img.src = u; });
  }
}, { rootMargin: '400px' });

async function restorePages() {
  await store.migrate();
  archive.push(...((await store.loadArchive()) || []).filter((e) => !archive.some((a) => a.id === e.id)));
  for (const sec of ['image', 'text']) {
    if (books[sec].length) continue;
    const saved = await store.loadList(sec);
    if (saved && saved.length) books[sec].push(...saved);
  }
  updateCount();
  const total = books.image.length + books.text.length;
  if (total) toast(`Oldingi ${total} ta sahifa tiklandi`);
  ocrQueue();
}

function switchSection(sec) {
  if (sec === section) return;
  pdfs[section] = lastPdf;
  section = sec;
  pages = books[sec];
  lastPdf = pdfs[sec];
  app.dataset.section = sec;
  document.body.dataset.section = sec;
  document.querySelectorAll('#sections button').forEach((b) => b.classList.toggle('on', b.dataset.section === sec));
  updateCount();
  if (app.dataset.state === 'review') render();
  else if (app.dataset.state !== 'live') openGallery();
  if (sec === 'text') warmUpOcr();
  toast(sec === 'text'
    ? '📝 Matn bo‘limi: sahifadagi matn o‘qib olinadi'
    : '🖼 Rasm bo‘limi: sahifa rasm sifatida saqlanadi');
}

// ---------------------------------------------------------------- Matnni o'qish (OCR)
// Uch usul: telefonning o'zida (Tesseract), Google Gemini yoki Claude orqali (internet).
// Bulutli usulda internet uzilsa, sahifa telefonning o'zida o'qiladi.
const ocr = { slots: [], running: false, errShown: false };
const OCR_RECYCLE = 40;          // ishchi shuncha sahifadan keyin xotirani bo'shatish uchun qayta yaratiladi
const OCR_TIMEOUT_MS = 240000;   // telefonda bitta sahifa shundan uzoq o'qilsa, to'xtatiladi
const OCR_MAX_DIM = 1800;        // telefonda o'qishdan oldin rasm shu o'lchamgacha kichraytiriladi
const CLOUD_MAX_DIM = 1568;      // bulutga yuboriladigan rasm o'lchami (internetni tejaydi)
const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

const OCR_PROMPT = `You are an OCR engine for photographed book pages.
Transcribe all of the page's text exactly as printed, in its original language and script (Uzbek Latin, Uzbek Cyrillic, Russian, English or other). Never translate, correct, summarize or comment.
- Keep Uzbek letters exactly: oʻ gʻ ʼ (and Cyrillic ў қ ғ ҳ).
- Join the lines of one paragraph into a single line and remove end-of-line hyphenation.
- Separate paragraphs and headings with one blank line.
- Leave out the running header and the page number.
Return only the transcribed text. If the page has no text, return nothing.`;

// ---------- Sozlamalar (shu brauzerda saqlanadi)
const ls = {
  get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } },
};
function ocrProvider() { return ls.get('kitob-ocr', 'local'); }
function apiKey(prov = ocrProvider()) { return ls.get('kitob-key-' + prov).trim(); }
function claudeModel() { return ls.get('kitob-claude-model', 'claude-opus-5-5'); }
function isCloud(prov = ocrProvider()) { return prov !== 'local' && !!apiKey(prov); }
const PROVIDER_NAME = { local: '📱 Telefonda', gemini: '☁ Gemini', claude: '☁ Claude' };

function updateOcrChip() {
  const prov = isCloud() ? ocrProvider() : 'local';
  $('#ocrSettings').textContent = PROVIDER_NAME[prov] + ' ⚙';
  document.body.dataset.ocr = prov === 'local' ? 'local' : 'cloud';
}

// Kuchsiz telefon uchun bitta ishchi; bulutda tarmoq kutiladi, shuning uchun bir nechta
function ocrSlotCount() {
  if (isCloud()) return ocrProvider() === 'gemini' ? 2 : 3;
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  return mem >= 8 && cores >= 8 ? 2 : 1;
}

function langCode() { return $('#lang').value; }
function langName(code) {
  const o = [...$('#lang').options].find((x) => x.value === code);
  if (o) return o.textContent;
  return { gemini: 'Gemini', claude: 'Claude' }[code] || code;
}

// ---------- Telefonning o'zida (Tesseract)
async function slotWorker(slot) {
  if (!window.Tesseract) throw new Error('OCR moduli yuklanmadi — internetni tekshiring');
  const lang = langCode();
  if (slot.worker && slot.done >= OCR_RECYCLE) {
    await slot.worker.terminate().catch(() => {});
    slot.worker = null;
  }
  if (!slot.worker) {
    slot.ready = (async () => {
      slot.worker = await Tesseract.createWorker(lang, 1, {
        logger: (m) => {
          const p = slot.page;
          if (!p) return;
          if (m.status === 'recognizing text') p.progress = m.progress;
          else if (/load|initializ/i.test(m.status)) p.loading = true;
          updateCard(p);
        },
      });
      slot.lang = lang; slot.done = 0;
    })();
    try { await slot.ready; } catch (e) { slot.worker = null; throw e; }
  } else if (slot.lang !== lang) {
    await slot.worker.reinitialize(lang);
    slot.lang = lang;
  }
  return slot.worker;
}

// Matn bo'limiga kirilganda til modeli oldindan yuklab qo'yiladi (faqat telefonda o'qish uchun)
function warmUpOcr() {
  if (isCloud()) return;
  if (!window.Tesseract) { setTimeout(warmUpOcr, 1000); return; }
  if (!ocr.slots.length) ocr.slots = Array.from({ length: ocrSlotCount() }, () => ({}));
  const s = ocr.slots[0];
  if (!s.worker && !s.ready) slotWorker(s).catch(() => {});
}

async function resizeImage(blob, maxDim, asJpeg) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  if (s === 1 && !asJpeg) { bmp.close && bmp.close(); return blob; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  if (!asJpeg) return c;
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error('juda uzoq davom etdi')), ms))]);
}

function tidyText(t) {
  // Satr oxiridagi bo'g'in ko'chirishlarini birlashtiradi, xatboshilarni saqlaydi
  return t.replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((par) => par.replace(/(\p{L})[-­]\n(\p{Ll})/gu, '$1$2').replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function localOcr(slot, blob) {
  const worker = await slotWorker(slot);
  const { data } = await withTimeout(worker.recognize(await resizeImage(blob, OCR_MAX_DIM)), OCR_TIMEOUT_MS);
  slot.done++;
  return { text: tidyText(data.text), lang: slot.lang };
}

// ---------- Bulut orqali (Gemini / Claude)
class OfflineError extends Error {}
class KeyError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

let geminiModelName = null;
async function geminiFetch(path, key, body) {
  let res;
  try {
    res = await fetch(`${GEMINI_API}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new OfflineError('internet yo‘q');
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const msg = json.error?.message || `HTTP ${res.status}`;
  if (res.status === 400 && /api key/i.test(msg) || res.status === 401 || res.status === 403) throw new KeyError('kalit noto‘g‘ri yoki ruxsat yo‘q');
  const err = new Error(msg);
  err.status = res.status;
  throw err;
}

// Kalitga mos eng yangi "flash" modelni tanlaydi (model nomlari vaqt o'tib o'zgaradi)
async function geminiModel(key) {
  if (geminiModelName) return geminiModelName;
  const { models = [] } = await geminiFetch('models?pageSize=200', key);
  const ok = models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') &&
    /flash/.test(m.name) && !/(lite|image|tts|audio|live|embed|thinking)/.test(m.name));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const stable = (n) => (/(preview|exp)/.test(n) ? 0 : 1);
  ok.sort((a, b) => stable(b.name) - stable(a.name) || ver(b.name) - ver(a.name));
  if (!ok.length) throw new Error('mos Gemini modeli topilmadi');
  geminiModelName = ok[0].name;                     // masalan: "models/gemini-…-flash"
  return geminiModelName;
}

async function geminiOcr(jpeg, key) {
  const model = await geminiModel(key);
  const body = {
    systemInstruction: { parts: [{ text: OCR_PROMPT }] },
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'image/jpeg', data: await toBase64(jpeg) } },
      { text: 'Transcribe this page.' },
    ] }],
    generationConfig: { temperature: 0 },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const json = await geminiFetch(`${model}:generateContent`, key, body);
      const cand = json.candidates?.[0];
      if (!cand) throw new Error(json.promptFeedback?.blockReason ? 'rad etildi' : 'javob bo‘sh');
      return (cand.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
    } catch (e) {
      // Bepul limit (daqiqasiga so'rovlar) tugasa yoki server band bo'lsa — kutib, qayta urinamiz
      if ((e.status === 429 || e.status >= 500) && attempt < 6) { await sleep(Math.min(60000, 4000 * 2 ** attempt)); continue; }
      if (e.status === 429) throw new Error('Gemini limiti tugadi — birozdan keyin ↻ bilan qayta urinib ko‘ring');
      throw e;
    }
  }
}

let anthropicMod = null;
async function claudeClient(key) {
  if (!anthropicMod) {
    try { anthropicMod = await import(ANTHROPIC_SDK); } catch (e) { throw new OfflineError('internet yo‘q'); }
  }
  const Anthropic = anthropicMod.default;
  return { Anthropic, client: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 4 }) };
}

async function claudeOcr(jpeg, key) {
  const { Anthropic, client } = await claudeClient(key);
  const model = claudeModel();
  const params = {
    model,
    max_tokens: 16000,
    output_config: { effort: 'low' },                // oddiy vazifa — kam o'ylash, tezroq va arzonroq
    system: OCR_PROMPT,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64(jpeg) } },
      { type: 'text', text: 'Transcribe this page.' },
    ] }],
  };
  let res;
  try {
    res = model === 'claude-opus-5-5'
      // Xavfsizlik filtri noto'g'ri rad etsa, server so'rovni boshqa modelda qayta bajaradi
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new KeyError('kalit noto‘g‘ri yoki ruxsat yo‘q');
    if (e instanceof Anthropic.RateLimitError) throw new Error('limit tugadi — birozdan keyin ↻ bilan qayta urinib ko‘ring');
    if (e instanceof Anthropic.APIConnectionError) throw new OfflineError('internet yo‘q');
    if (e instanceof Anthropic.APIError) throw new Error(e.message);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('sahifa rad etildi');
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function cloudOcr(blob) {
  const prov = ocrProvider(), key = apiKey(prov);
  if (!navigator.onLine) throw new OfflineError('internet yo‘q');
  const jpeg = await resizeImage(blob, CLOUD_MAX_DIM, true);
  const raw = prov === 'gemini' ? await geminiOcr(jpeg, key) : await claudeOcr(jpeg, key);
  return { text: raw.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim(), lang: prov };
}

// ---------- Navbat
async function runSlot(slot) {
  let p;
  while ((p = books.text.find((x) => x.status === 'pending'))) {
    p.status = 'working'; p.progress = 0; p.loading = false; p.cloud = isCloud(); slot.page = p;
    updateCard(p); updateCount();
    try {
      const blob = await store.getBlob(p.img);
      let r;
      if (p.cloud) {
        try { r = await cloudOcr(blob); } catch (e) {
          if (!(e instanceof OfflineError)) throw e;
          p.cloud = false; updateCard(p);                // internet yo'q — telefonning o'zida o'qiymiz
          if (!ocr.offlineShown) { ocr.offlineShown = true; toast('Internet yo‘q — sahifalar telefonning o‘zida o‘qilmoqda'); }
          r = await localOcr(slot, blob);
        }
      } else {
        r = await localOcr(slot, blob);
      }
      if (!books.text.includes(p)) continue;          // o'qilayotganda o'chirilgan
      p.text = r.text;
      p.lang = r.lang;
      p.status = 'done';
    } catch (e) {
      p.status = 'error';
      p.error = e.message || String(e);
      if (e instanceof KeyError) {
        toast('⚠ API kalit noto‘g‘ri. «⚙» orqali kalitni tekshiring');
        books.text.filter((x) => x.status === 'pending').forEach((x) => { x.status = 'error'; x.error = p.error; updateCard(x); });
      } else if (!ocr.errShown) { ocr.errShown = true; toast('⚠ Matnni o‘qib bo‘lmadi: ' + p.error); }
      if (slot.worker && !p.cloud) { slot.worker.terminate().catch(() => {}); slot.worker = null; slot.ready = null; }
    } finally {
      slot.page = null;
    }
    updateCard(p);
    store.saveList('text');
    updateCount();
  }
}

async function ocrQueue() {
  if (ocr.running || !books.text.some((x) => x.status === 'pending')) return;
  ocr.running = true;
  keepAwake();
  try {
    // Usul o'zgargan bo'lsa, ishchilar soni ham yangilanadi (eski Tesseract ishchilari saqlanadi)
    const n = ocrSlotCount();
    while (ocr.slots.length < n) ocr.slots.push({});
    await Promise.all(ocr.slots.slice(0, n).map(runSlot));
  } finally {
    ocr.running = false;
  }
  if (books.text.some((x) => x.status === 'pending')) ocrQueue();   // ish davomida yangi sahifa qo'shilgan bo'lsa
}

function waitingCount() {
  return books.text.filter((p) => p.status === 'pending' || p.status === 'working').length;
}

function onLangChange() {
  ls.set('kitob-lang3', langCode());
  const lang = langCode();
  const other = books.text.filter((p) => p.status === 'done' && p.lang && p.lang !== lang && !['gemini', 'claude'].includes(p.lang));
  toast(`Til: ${langName(lang)}. Keyingi sahifalar shu tilda o‘qiladi`);
  if (other.length && confirm(`${other.length} ta sahifa boshqa tilda o‘qilgan.\nUlarni ham «${langName(lang)}» tilida qaytadan o‘qiymi?\n(Ulardagi qo‘lda tuzatishlar o‘chadi)`)) {
    other.forEach((p) => { p.status = 'pending'; p.text = ''; });
    store.saveList('text');
    if (app.dataset.state === 'gallery') renderGallery();
    updateCount();
    ocrQueue();
  }
}

// ---------- O'qish usuli oynasi
const KEY_HELP = {
  gemini: 'Bepul kalit olish: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> → Google hisobingiz bilan kiring → «Create API key» → kalitni nusxalab shu yerga qo‘ying.',
  claude: 'Kalit olish: <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> → ro‘yxatdan o‘ting, hisobni to‘ldiring → «Create Key» → kalitni shu yerga qo‘ying.',
};

function ocrDialogProvider() { return $('#ocrOpts').querySelector('input:checked')?.value || 'local'; }

function refreshOcrDialog() {
  const prov = ocrDialogProvider();
  $('#cloudBox').hidden = prov === 'local';
  $('#claudeModelField').hidden = prov !== 'claude';
  if (prov !== 'local') {
    $('#keyLabel').textContent = prov === 'gemini' ? 'Google Gemini API kaliti' : 'Anthropic (Claude) API kaliti';
    $('#keyHelp').innerHTML = KEY_HELP[prov];
    $('#apiKey').value = apiKey(prov);
  }
  $('#keyStatus').textContent = '';
}

function openOcrDialog() {
  const prov = ocrProvider();
  $('#ocrOpts').querySelectorAll('input').forEach((i) => { i.checked = i.value === prov; });
  $('#claudeModel').value = claudeModel();
  refreshOcrDialog();
  $('#ocrDialog').returnValue = '';
  $('#ocrDialog').showModal();
}

async function testKey() {
  const prov = ocrDialogProvider(), key = $('#apiKey').value.trim(), st = $('#keyStatus');
  if (!key) { st.textContent = 'Avval kalitni kiriting'; return; }
  st.textContent = 'Tekshirilmoqda…';
  try {
    if (prov === 'gemini') {
      geminiModelName = null;
      const m = await geminiModel(key);
      st.textContent = `✔ Kalit ishlaydi (${m.replace('models/', '')})`;
    } else {
      const { Anthropic, client } = await claudeClient(key);
      try {
        // Tokenlarni sanash bepul — kalitni pul sarflamasdan tekshiradi
        await client.messages.countTokens({ model: $('#claudeModel').value, messages: [{ role: 'user', content: 'test' }] });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new KeyError('kalit noto‘g‘ri');
        if (e instanceof Anthropic.APIConnectionError) throw new OfflineError('internet yo‘q');
        throw e;
      }
      st.textContent = '✔ Kalit ishlaydi';
    }
  } catch (e) {
    st.textContent = '✖ ' + (e instanceof KeyError || /401|403|auth|permission/i.test(String(e.status || e.message))
      ? 'Kalit noto‘g‘ri' : e instanceof OfflineError ? 'Internet yo‘q' : (e.message || 'xato'));
  }
}

$('#ocrOpts').addEventListener('change', refreshOcrDialog);
$('#testKey').onclick = testKey;
$('#ocrSettings').onclick = openOcrDialog;
$('#ocrDialog').addEventListener('close', () => {
  if ($('#ocrDialog').returnValue !== 'ok') return;
  const prov = ocrDialogProvider();
  if (prov !== 'local') {
    const key = $('#apiKey').value.trim();
    if (!key) { toast('Kalit kiritilmadi — telefonda o‘qish usuli qoldi'); return; }
    if (key !== apiKey(prov)) geminiModelName = null;
    ls.set('kitob-key-' + prov, key);
    if (prov === 'claude') ls.set('kitob-claude-model', $('#claudeModel').value);
  }
  ls.set('kitob-ocr', prov);
  ocr.errShown = false; ocr.offlineShown = false;
  updateOcrChip();
  toast(`O‘qish usuli: ${PROVIDER_NAME[prov]}`);
  // Kalit xatosi tufayli to'xtagan sahifalarni yangi sozlama bilan qayta o'qiymiz
  const failed = books.text.filter((p) => p.status === 'error');
  if (failed.length && confirm(`${failed.length} ta sahifa o‘qilmay qolgan. Ularni yangi usulda qayta o‘qiymi?`)) {
    failed.forEach((p) => { p.status = 'pending'; p.text = ''; });
    store.saveList('text');
    if (app.dataset.state === 'gallery') renderGallery();
  }
  updateCount();
  ocrQueue();
  if (!isCloud()) warmUpOcr();
});

// Ekran o'chib qolmasin — aks holda kamera va matn o'qish to'xtaydi
let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* qo'llab-quvvatlanmaydi */ }
}

// ---------------------------------------------------------------- Suratga olish
function capture() {
  if (app.dataset.state !== 'live' || !video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(1, MAX_DIM / Math.max(vw, vh));
  raw = document.createElement('canvas');
  raw.width = Math.round(vw * s); raw.height = Math.round(vh * s);
  raw.getContext('2d').drawImage(video, 0, 0, raw.width, raw.height);
  rawQuad = lastQuad ? lastQuad.map(([x, y]) => [x * s, y * s]) : detectQuad(raw, raw.width, raw.height);
  rotation = 0;
  progress.style.width = '0';
  flash();
  render();
  setState('review');
}

function render() {
  current = processPage();
  result.src = current.toDataURL('image/jpeg', JPEG_Q);
}

let persistAsked = false;
async function savePage() {
  if (!current) return;
  const c = current;
  current = null; raw = null;
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', JPEG_Q));
  const { img, th } = await store.saveImages(blob);
  const page = { id: Date.now() + Math.random(), w: c.width, h: c.height, img, th };
  if (section === 'text') Object.assign(page, { text: '', status: 'pending' });
  pages.push(page);
  lastPdf = null;
  updateCount();
  await store.saveList();
  if (section === 'text') ocrQueue();
  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});      // brauzer joy tanqisligida o'chirib yubormasin
  }
}

function backToLive() {
  cooldownUntil = performance.now() + AUTO_COOLDOWN_MS;
  prevQuad = null;
  setState('live');
}

// ---------------------------------------------------------------- Sahifalar galereyasi
function openGallery() {
  renderGallery();
  setState('gallery');
  const panel = $('#gallery');
  requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });   // eng oxirgi sahifalar ko'rinsin
}

function lazyImg(img, key) {
  img.dataset.key = key;
  const cached = urlCache.get(key);
  if (cached) img.src = cached; else lazy.observe(img);
}

function renderGallery() {
  const grid = $('#grid');
  grid.querySelectorAll('img').forEach((i) => lazy.unobserve(i));
  grid.innerHTML = '';
  grid.classList.toggle('list', section === 'text');
  $('#makePdf').disabled = !pages.length;
  if (section === 'text') { renderTextGallery(grid); return; }
  if (!pages.length) {
    grid.innerHTML = '<div class="empty">Hali sahifa yo‘q. «Davom ettirish»ni bosib, sahifalarni suratga oling.</div>';
  }
  const frag = document.createDocumentFragment();
  pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `<img alt="${i + 1}-sahifa"><span class="num">${i + 1}</span>
      <div class="acts">
        <button data-act="left" title="Oldinga" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button data-act="del" class="del" title="O‘chirish">🗑</button>
        <button data-act="right" title="Orqaga" ${i === pages.length - 1 ? 'disabled' : ''}>▶</button>
      </div>`;
    const img = el.querySelector('img');
    lazyImg(img, p.th);
    img.onclick = () => showViewer(p.img);
    el.querySelector('.acts').onclick = (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act) movePage(i, act);
    };
    frag.appendChild(el);
  });
  grid.appendChild(frag);
}

function movePage(i, act) {
  const panel = $('#gallery'), top = panel.scrollTop;
  if (act === 'del') {
    if (!confirm(`${i + 1}-sahifani o‘chirasizmi?`)) return;
    pages.splice(i, 1);
  } else {
    const j = act === 'left' ? i - 1 : i + 1;
    [pages[i], pages[j]] = [pages[j], pages[i]];
  }
  lastPdf = null;
  updateCount();
  store.saveList().then(() => act === 'del' && store.gc());
  renderGallery();
  panel.scrollTop = top;
}

function renderTextGallery(grid) {
  if (!pages.length) {
    grid.innerHTML = '<div class="empty">Hali sahifa yo‘q. «Davom ettirish»ni bosib, sahifalarni suratga oling — matni o‘zi o‘qib olinadi.</div>';
  }
  const frag = document.createDocumentFragment();
  pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'tcard';
    el.dataset.id = p.id;
    el.innerHTML = `
      <div class="side">
        <img alt="${i + 1}-sahifa">
        <div class="acts">
          <button data-act="left" title="Oldinga" ${i === 0 ? 'disabled' : ''}>◀</button>
          <button data-act="right" title="Orqaga" ${i === pages.length - 1 ? 'disabled' : ''}>▶</button>
          <button data-act="del" class="del" title="O‘chirish">🗑</button>
          <button data-act="redo" title="Matnni hozirgi tilda qayta o‘qish">↻</button>
        </div>
      </div>
      <div class="main">
        <div class="head"><span>${i + 1}-sahifa</span><span class="status"></span></div>
        <div class="bar-mini"><i></i></div>
        <textarea spellcheck="false" placeholder="Matn…"></textarea>
      </div>`;
    const img = el.querySelector('img');
    lazyImg(img, p.th);
    img.onclick = () => showViewer(p.img);
    const ta = el.querySelector('textarea');
    ta.value = p.text || '';
    ta.oninput = () => {
      p.text = ta.value;
      lastPdf = null;
      clearTimeout(ta.t); ta.t = setTimeout(() => store.saveList('text'), 500);
    };
    el.querySelector('.acts').onclick = (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      if (act === 'redo') {
        if (p.status === 'working') return;
        if (p.text && !confirm(`Sahifa «${langName(langCode())}» tilida qaytadan o‘qiladi, tuzatishlaringiz o‘chadi. Davom etasizmi?`)) return;
        p.status = 'pending'; p.text = ''; lastPdf = null;
        updateCard(p); store.saveList('text'); updateCount(); ocrQueue();
        return;
      }
      movePage(i, act);
    };
    frag.appendChild(el);
  });
  grid.appendChild(frag);
  pages.forEach(updateCard);
}

function updateCard(p) {
  const el = document.querySelector(`.tcard[data-id="${p.id}"]`);
  if (!el) return;
  const st = el.querySelector('.status'), bar = el.querySelector('.bar-mini'), ta = el.querySelector('textarea');
  const texts = {
    pending: '⏳ Navbatda',
    working: p.cloud
      ? '☁ Internet orqali o‘qilmoqda…'
      : p.loading && !p.progress
        ? '⬇ Til ma’lumotlari yuklanmoqda…'
        : `🔍 Matn o‘qilmoqda… ${Math.round((p.progress || 0) * 100)}%`,
    done: `✔ ${p.lang ? langName(p.lang) + ' · ' : ''}${(p.text || '').split(/\s+/).filter(Boolean).length} so‘z`,
    error: `⚠ Xato: ${p.error || 'o‘qib bo‘lmadi'} — ↻ bilan qayta urinib ko‘ring`,
  };
  st.textContent = texts[p.status] || '';
  st.classList.toggle('err', p.status === 'error');
  bar.style.display = p.status === 'working' && !p.cloud ? 'block' : 'none';
  bar.firstElementChild.style.width = Math.round((p.progress || 0) * 100) + '%';
  const busy = p.status === 'pending' || p.status === 'working';
  ta.disabled = busy;
  if (!busy && document.activeElement !== ta && ta.value !== (p.text || '')) ta.value = p.text || '';
}

let viewerUrl = null;
async function showViewer(key) {
  const blob = await store.getBlob(key);
  if (!blob) return;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(blob);
  const v = $('#viewer');
  v.querySelector('img').src = viewerUrl;
  v.classList.add('show');
}
$('#viewer').onclick = () => $('#viewer').classList.remove('show');

// ---------------------------------------------------------------- PDF
function defaultName() {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `Kitob_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function cleanName(s) {
  const n = s.trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  return n || defaultName();
}

// Bitta oyna uch xil ish uchun: ish ro'yxatidan PDF, ish ro'yxatini arxivlash,
// arxivdagi (hali PDF qilinmagan) yozuvdan PDF yaratish
const dlgState = { mode: 'pdf', entry: null, list: [], sec: 'image' };

function openDialog(mode, entry) {
  const list = entry ? entry.pages : pages;
  const sec = entry ? entry.section : section;
  if (!list.length) { toast('Hali birorta ham sahifa saqlanmagan'); return; }
  if (!entry && sec === 'text' && waitingCount()) {
    toast(`Matn o‘qilishi tugashini kuting: yana ${waitingCount()} ta sahifa qoldi`);
    return;
  }
  Object.assign(dlgState, { mode, entry, list, sec });
  document.body.dataset.dlg = mode;
  const n = list.length;
  $('#dialogTitle').textContent = mode === 'archive' ? '🗂 Arxivlash' : '📄 PDF yaratish';
  $('#dialogOk').textContent = mode === 'archive' ? '🗂 Arxivlash' : '📄 Yaratish';
  $('#dialogInfo').textContent = mode === 'archive'
    ? `${n} ta sahifa arxivga o‘tadi va asosiy ro‘yxatdan olib tashlanadi. PDF’ni keyinroq arxivdan yaratishingiz mumkin.`
    : sec === 'text'
      ? `${n} ta sahifaning matni bitta matnli PDF faylga yig‘iladi.`
      : `${n} ta sahifa bitta PDF faylga yig‘iladi.`;
  $('#pdfName').value = entry ? entry.name.replace(/\.pdf$/, '') : lastPdf ? lastPdf.name.replace(/\.pdf$/, '') : defaultName();
  $('#pdfQuality').value = n > 100 ? 'medium' : 'high';
  $('#qualityField').hidden = mode === 'archive' || sec === 'text';
  sizeSample = null;
  if (!$('#qualityField').hidden) updateSizeHint();
  const dlg = $('#pdfDialog');
  dlg.returnValue = '';
  dlg.showModal();
  setTimeout(() => $('#pdfName').select(), 50);
}
function askPdfName() { openDialog('pdf'); }

const QUALITY = {
  high: { dim: 0, q: 0 },                    // asl rasmlar, qayta siqilmaydi
  medium: { dim: 1400, q: 0.7 },
  low: { dim: 1100, q: 0.55 },               // matn hali bemalol o'qiladi
};

// Hajmni bir nechta haqiqiy sahifani siqib ko'rib taxmin qiladi
let sizeSample = null;
async function updateSizeHint() {
  const el = $('#sizeHint'), quality = $('#pdfQuality').value, list = dlgState.list;
  el.textContent = 'Hajm hisoblanmoqda…';
  if (!sizeSample) {
    const idx = [...new Set([0, Math.floor(list.length / 2), list.length - 1])];
    sizeSample = (await Promise.all(idx.map((i) => store.getBlob(list[i].img)))).filter(Boolean);
    sizeSample.cache = {};
  }
  if (!sizeSample.length) { el.textContent = ''; return; }
  if (sizeSample.cache[quality] === undefined) {
    let sum = 0;
    for (const b of sizeSample) sum += quality === 'high' ? b.size : (await shrink(b, QUALITY[quality])).blob.size;
    sizeSample.cache[quality] = sum / sizeSample.length;
  }
  if ($('#pdfQuality').value !== quality) return;
  const mb = (sizeSample.cache[quality] * list.length) / 1048576;
  el.textContent = `Taxminiy hajm: ~${mb < 1 ? '1' : Math.round(mb)} MB` +
    (mb > 100 && quality !== 'low'
      ? ` — katta fayl, ${quality === 'high' ? '«O‘rta» yoki «Past»' : '«Past»'}ni tanlash tavsiya etiladi`
      : '');
}
$('#pdfQuality').onchange = updateSizeHint;

$('#pdfDialog').addEventListener('close', () => {
  if ($('#pdfDialog').returnValue !== 'ok') return;
  const name = cleanName($('#pdfName').value), quality = $('#pdfQuality').value;
  if (dlgState.mode === 'archive') archiveCurrent(name);
  else if (dlgState.mode === 'archivePdf') pdfForEntry(dlgState.entry, name, quality);
  else makePdf(name, quality);
});

function busy(text, frac) {
  const b = $('#busy');
  if (text === null) { b.classList.remove('show'); return; }
  b.classList.add('show');
  b.querySelector('.btext').textContent = text;
  b.querySelector('.bfill').style.width = Math.round((frac || 0) * 100) + '%';
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function buildPdf(list, sec, quality) {
  keepAwake();
  busy('PDF tayyorlanmoqda…', 0);
  try {
    return sec === 'text' ? await buildTextPdf(list) : await buildImagePdf(quality, list);
  } catch (e) {
    toast('PDF yaratib bo‘lmadi: ' + (e.message || e));
    return null;
  } finally {
    busy(null);
  }
}

// Ish ro'yxatidagi sahifalarni arxivga ko'chiradi va ro'yxatni bo'shatadi
async function moveToArchive(name, pdf) {
  const entry = {
    id: Date.now(), name: name + '.pdf', date: Date.now(), section,
    pdfKey: pdf ? await store.putBlob(pdf) : null, size: pdf ? pdf.size : 0,
    pages: pages.map(({ w, h, img, th, text }) => ({ w, h, img, th, text })),
  };
  archive.unshift(entry);
  await store.saveArchive();
  pages.length = 0;
  lastPdf = null;
  await store.saveList();
  updateCount();
  return entry;
}

async function makePdf(name, quality = 'high') {
  const n = pages.length;
  const blob = await buildPdf(pages, section, quality);
  if (!blob) return;
  const entry = await moveToArchive(name, blob);
  lastPdf = entry;
  download(entry, blob);
  $('#doneTitle').textContent = section === 'text' ? `${n} sahifali matnli PDF tayyor` : `${n} sahifali PDF tayyor`;
  $('#doneName').value = name;
  setState('done');
}

async function archiveCurrent(name) {
  const n = pages.length;
  await moveToArchive(name, null);
  toast(`${n} ta sahifa arxivga o‘tkazildi`);
  openArchive();
}

async function pdfForEntry(entry, name, quality) {
  const blob = await buildPdf(entry.pages, entry.section, quality);
  if (!blob) return;
  entry.name = name + '.pdf';
  entry.pdfKey = await store.putBlob(blob);
  entry.size = blob.size;
  await store.saveArchive();
  download(entry, blob);
  renderArchive();
  showStorage();
}

// Yangi skanerlash: ish ro'yxatida sahifa bo'lsa, avval ularni arxivlashni taklif qiladi
function newScan() {
  if (pages.length) {
    if (section === 'text' && waitingCount()) {
      toast(`Avval matn o‘qilishi tugashini kuting: yana ${waitingCount()} ta sahifa qoldi`);
      return;
    }
    if (!confirm(`Hozirgi ro‘yxatda ${pages.length} ta sahifa bor.\nUlarni arxivga o‘tkazib, yangi skanerlashni boshlaymizmi?`)) return;
    archiveCurrent(defaultName()).then(() => { backToLive(); toast('Yangi skanerlash boshlandi. Oldingi sahifalar arxivda'); });
    return;
  }
  lastPdf = null;
  backToLive();
  toast('Yangi skanerlash: birinchi sahifani ko‘rsating');
}

let fontCache = null;
async function loadFont() {
  // Kirill va o'zbek harflari (oʻ, gʻ) uchun shrift — faqat matnli PDF kerak bo'lganda yuklanadi
  if (!fontCache) {
    const res = await fetch('https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf');
    if (!res.ok) throw new Error('shrift yuklanmadi');
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    fontCache = bin;
  }
  return fontCache;
}

async function buildTextPdf(list = pages) {
  const { jsPDF } = window.jspdf;
  busy('Shrift yuklanmoqda…', 0);
  const font = await loadFont();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('DejaVuSans.ttf', font);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.setFont('DejaVu', 'normal');

  const W = 210, H = 297, M = 20, size = 12;
  const lineH = size * 0.3528 * 1.45;                       // pt → mm, qator oralig'i 1.45
  doc.setFontSize(size);
  for (const [i, p] of list.entries()) {
    if (i > 0) doc.addPage();
    let y = M + lineH;
    const paragraphs = (p.text || '').split(/\n\s*\n/);
    paragraphs.forEach((par, k) => {
      const lines = doc.splitTextToSize(par.replace(/\n/g, ' '), W - 2 * M);
      for (const line of lines) {
        if (y > H - M) { doc.addPage(); y = M + lineH; }
        doc.text(line, M, y);
        y += lineH;
      }
      if (k < paragraphs.length - 1) y += lineH * 0.6;     // xatboshilar orasida bo'shliq
    });
    // pastda kitobdagi sahifa raqami
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text(`— ${i + 1} —`, W / 2, H - 10, { align: 'center' });
    doc.setTextColor(0);
    doc.setFontSize(size);
    if (i % 10 === 0) { busy(`PDF: ${i + 1} / ${list.length} sahifa`, (i + 1) / list.length); await tick(); }
  }
  busy('PDF yakunlanmoqda…', 1);
  await tick();
  return doc.output('blob');
}

// JPEG sarlavhasidan rang kanallari sonini o'qiydi (1 — kulrang, 3 — rangli)
async function jpegComponents(blob) {
  const b = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9];
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return 3;
}

async function shrink(blob, q) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, q.dim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const out = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', q.q));
  return { blob: out, w: c.width, h: c.height };
}

// Rasmli PDF'ni qo'lda yozamiz: JPEG'lar PDF ichiga to'g'ridan-to'g'ri qo'yiladi va
// hammasi xotiraga yuklanmaydi — 500 sahifali kitob ham telefonda yig'iladi.
async function buildImagePdf(quality, list = pages) {
  const q = QUALITY[quality] || QUALITY.high;
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let pos = 0;
  const add = (x) => {
    if (typeof x === 'string') x = enc.encode(x);
    parts.push(x);
    pos += x.size !== undefined ? x.size : x.length;
  };
  const obj = (n, body) => { offsets[n] = pos; add(`${n} 0 obj\n${body}\nendobj\n`); };

  const n = list.length;
  // 1 — katalog, 2 — sahifalar ro'yxati, keyin har sahifa uchun 3 ta obyekt
  const pageObj = (i) => 3 + i * 3;
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${list.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);

  for (const [i, p] of list.entries()) {
    let blob = await store.getBlob(p.img), w = p.w, h = p.h;
    if (!blob) throw new Error(`${i + 1}-sahifa rasmi topilmadi`);
    if (q.dim && Math.max(w, h) > q.dim) ({ blob, w, h } = await shrink(blob, q));
    const comps = await jpegComponents(blob);
    const cs = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';

    const PW = 595.28, PH = +(PW * h / w).toFixed(2);       // eni A4, bo'yi sahifaga mos
    const k = pageObj(i);
    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(k, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${k + 2} 0 R >> >> /Contents ${k + 1} 0 R >>`);
    obj(k + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[k + 2] = pos;
    add(`${k + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${blob.size} >>\nstream\n`);
    add(blob);
    add('\nendstream\nendobj\n');

    if (i % 5 === 0 || i === n - 1) { busy(`PDF: ${i + 1} / ${n} sahifa`, (i + 1) / n); await tick(); }
  }

  const total = 3 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  add(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

async function copyAllText() {
  const src = lastPdf ? lastPdf.pages : pages;
  const all = src.map((p) => p.text || '').filter(Boolean).join('\n\n');
  try { await navigator.clipboard.writeText(all); toast('Butun matn nusxalandi'); }
  catch (e) { toast('Nusxalab bo‘lmadi'); }
}

async function pdfBlob(entry) { return store.getBlob(entry.pdfKey); }

async function download(entry = lastPdf, blob) {
  if (!entry) return;
  blob = blob || await pdfBlob(entry);
  if (!blob) { toast('PDF fayli topilmadi'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = entry.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(`Yuklandi: ${entry.name}`);
}

function renamedPdf() {
  if (lastPdf) {
    lastPdf.name = cleanName($('#doneName').value) + '.pdf';
    store.saveArchive();
  }
  return lastPdf;
}

async function share(entry) {
  const pdf = entry || renamedPdf();
  const file = new File([await pdfBlob(pdf)], pdf.name, { type: 'application/pdf' });
  try { await navigator.share({ files: [file], title: pdf.name }); } catch (e) { /* bekor qilindi */ }
}


// ---------------------------------------------------------------- Arxiv
function openArchive() {
  renderArchive();
  setState('archive');
  showStorage();
}

async function showStorage() {
  const el = $('#storageInfo');
  try {
    const { usage, quota } = await navigator.storage.estimate();
    el.textContent = `Band qilingan joy: ${fmtSize(usage)} (bo‘sh: ~${fmtSize(quota - usage)})`;
  } catch (e) { el.textContent = ''; }
}

function fmtSize(bytes) {
  const kb = bytes / 1024;
  if (kb < 1024) return Math.round(kb) + ' KB';
  if (kb < 1024 * 1024) return (kb / 1024).toFixed(1) + ' MB';
  return (kb / 1024 / 1024).toFixed(1) + ' GB';
}

function fmtDate(t) {
  const d = new Date(t), pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderArchive() {
  const list = $('#archiveList');
  list.querySelectorAll('img').forEach((i) => lazy.unobserve(i));
  list.innerHTML = '';
  if (!archive.length) {
    list.innerHTML = '<div class="empty">Arxiv hozircha bo‘sh. Sahifalarni «🗂 Arxivlash» yoki «📄 PDF yaratish» bilan shu yerga o‘tkazasiz.</div>';
  }
  for (const e of archive) {
    const el = document.createElement('div');
    el.className = 'acard';
    const hasPdf = !!e.pdfKey;
    el.innerHTML = `
      <div class="ahead">
        <div class="aicon">${e.section === 'text' ? '📝' : '🖼'}</div>
        <div class="ainfo">
          <div class="aname"></div>
          <div class="ameta">${fmtDate(e.date)} · ${e.pages.length} sahifa · ${hasPdf ? fmtSize(e.size || 0) : 'PDF hali yaratilmagan'} · ${e.section === 'text' ? 'Matnli' : 'Rasmli'}</div>
        </div>
      </div>
      <div class="aacts">
        ${hasPdf
          ? `<button data-act="dl">⬇ Yuklash</button>${$('#share').hidden ? '' : '<button data-act="share">↗ Ulashish</button>'}`
          : '<button data-act="mkpdf" class="primary">📄 PDF yaratish</button>'}
        <button data-act="rename">✏ Nom</button>
        <button data-act="view">👁 Sahifalar</button>
        <button data-act="reopen" title="Sahifalarni qayta tahrirga olish">↩ Tahrirga</button>
        <button data-act="del" class="del">🗑</button>
      </div>
      <div class="athumbs" hidden></div>`;
    el.querySelector('.aname').textContent = e.name;
    el.querySelector('.aacts').onclick = (ev) => archiveAction(e, ev.target.closest('button')?.dataset.act, el);
    list.appendChild(el);
  }
}

async function archiveAction(e, act, el) {
  if (!act) return;
  if (act === 'dl') download(e);
  else if (act === 'share') share(e);
  else if (act === 'mkpdf') openDialog('archivePdf', e);
  else if (act === 'rename') {
    const n = prompt('Yangi nom:', e.name.replace(/\.pdf$/, ''));
    if (n === null) return;
    e.name = cleanName(n) + '.pdf';
    await store.saveArchive();
    renderArchive();
  } else if (act === 'view') {
    const box = el.querySelector('.athumbs');
    if (box.hidden && !box.childElementCount) {
      e.pages.forEach((p, i) => {
        const t = document.createElement('div');
        t.className = 'athumb';
        t.innerHTML = `<img alt="${i + 1}-sahifa"><span>${i + 1}</span>`;
        if (p.text) t.title = p.text.slice(0, 300);
        lazyImg(t.querySelector('img'), p.th);
        t.onclick = () => showViewer(p.img);
        box.appendChild(t);
      });
    }
    box.hidden = !box.hidden;
  } else if (act === 'reopen') {
    const book = books[e.section];
    if (book.length && !confirm(`Hozirgi ish ro‘yxatida ${book.length} ta sahifa bor. Arxivdagi sahifalar ularning oxiriga qo‘shilsinmi?`)) return;
    book.push(...e.pages.map((p, i) => ({
      ...p, id: Date.now() + i + Math.random(),
      ...(e.section === 'text' ? { status: 'done' } : {}),
    })));
    await store.saveList(e.section);
    switchSection(e.section);
    updateCount();
    toast(`${e.pages.length} ta sahifa tahrirga olindi. PDF arxivda ham qoladi`);
    openGallery();
  } else if (act === 'del') {
    if (!confirm(`«${e.name}» va uning sahifalari arxivdan butunlay o‘chirilsinmi?`)) return;
    archive.splice(archive.indexOf(e), 1);
    if (lastPdf === e) lastPdf = null;
    await store.saveArchive();
    await store.gc();
    renderArchive();
    updateCount();
    showStorage();
  }
}

// ---------------------------------------------------------------- Yordamchilar
function setState(s) {
  app.dataset.state = s;
  if (s === 'live') { setMsg(''); drawOverlay(null); }
}
function updateCount() {
  $('#count').textContent = `${pages.length} sahifa`;
  $('#galleryCount').textContent = pages.length;
  const wait = waitingCount();
  $('#galleryLabel').textContent = section === 'text'
    ? (wait ? `📝 Matnlar (o‘qilmoqda: ${wait})` : '📝 Matnlar')
    : '🖼 Sahifalar';
  $('#archiveCount').textContent = archive.length;
}
function setMsg(t) { msg.textContent = t; msg.dataset.kind = ''; }
function toast(t) {
  const el = $('#toast');
  el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}
function flash() {
  $('#stage').animate([{ background: '#fff' }, { background: '#0c0c0f' }], { duration: 250 });
}

// ---------------------------------------------------------------- Hodisalar
$('#shutter').onclick = capture;
$('#next').onclick = async () => {
  await savePage();
  backToLive();
  toast(section === 'text'
    ? `${pages.length}-sahifa saqlandi, matni o‘qilmoqda. Keyingisini ko‘rsating`
    : `${pages.length}-sahifa saqlandi. Keyingisini ko‘rsating`);
};
$('#retake').onclick = () => { current = null; raw = null; backToLive(); };
$('#rotate').onclick = () => { rotation = (rotation + 1) % 4; render(); };
$('#openGallery').onclick = openGallery;
$('#count').onclick = () => app.dataset.state === 'live' && openGallery();
$('#backToCam').onclick = backToLive;
$('#makePdf').onclick = askPdfName;
$('#download').onclick = () => { renamedPdf(); download(); };
$('#doneBack').onclick = () => { renamedPdf(); openArchive(); };
$('#newBook').onclick = () => { renamedPdf(); newScan(); };
$('#openArchive').onclick = openArchive;
$('#archiveBack').onclick = newScan;
$('#archiveNow').onclick = () => openDialog('archive');
$('#newScan').onclick = newScan;
$('#copyText').onclick = copyAllText;
$('#sections').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) switchSection(b.dataset.section);
});
{ const l = ls.get('kitob-lang3'); if (l && [...$('#lang').options].some((o) => o.value === l)) $('#lang').value = l; }
updateOcrChip();
$('#lang').onchange = onLangChange;
$('#switchCam').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
if (navigator.canShare && navigator.canShare({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] })) {
  $('#share').hidden = false;
  $('#share').onclick = () => share();
}

$('#modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mode = b.dataset.mode;
  document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b));
  if (app.dataset.state === 'review' && raw) render();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const s = app.dataset.state;
  if (e.code === 'Space' && s === 'live') { e.preventDefault(); capture(); }
  else if (e.key === 'Enter' && s === 'review') $('#next').click();
  else if (e.key === 'Escape' && s === 'review') $('#retake').click();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (!stream || !stream.active) startCamera();
});


restorePages();
startCamera();
keepAwake();
liveLoop();
