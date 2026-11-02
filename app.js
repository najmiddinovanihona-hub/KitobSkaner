// Kitob Skaner — brauzerda kamera orqali sahifalarni nusxalab, PDF qilib beradi.

const $ = (s) => document.querySelector(s);
const app = $('#app'), video = $('#video'), overlay = $('#overlay'), result = $('#result');
const msg = $('#msg'), progress = $('#progress');

const MAX_DIM = 2200;            // olingan rasmning eng katta tomoni
const DETECT_W = 480;            // sahifani topish uchun kichik kadr eni
const AUTO_STABLE_MS = 1300;     // avto-olish: sahifa shuncha qimirlamasa
const AUTO_COOLDOWN_MS = 2500;
const JPEG_Q = 0.88;

let cvReady = false;
let stream = null, facing = 'environment';
let mode = 'gray';
let pages = [];                  // {id, blob, url, w, h} — saqlangan sahifalar
let raw = null, rawQuad = null, rotation = 0, current = null;
let lastQuad = null, prevQuad = null, stableSince = 0, cooldownUntil = 0;
let lastPdf = null;               // {blob, name}

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
    const done = enhance(page, mode);
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
const store = {
  db: null,
  async open() {
    if (this.db || !window.indexedDB) return this.db;
    this.db = await new Promise((ok, fail) => {
      const req = indexedDB.open('kitob-skaner', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    }).catch(() => null);
    return this.db;
  },
  async run(fn) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((ok) => {
      const tx = db.transaction('kv', 'readwrite'), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => ok(req && req.result);
      tx.onerror = () => ok(null);
    });
  },
  save() {
    return this.run((s) => s.put(pages.map(({ id, blob, w, h }) => ({ id, blob, w, h })), 'pages'));
  },
  load() { return this.run((s) => s.get('pages')); },
};

async function restorePages() {
  const saved = await store.load();
  if (!saved || !saved.length) return;
  pages = saved.map((p) => ({ ...p, url: URL.createObjectURL(p.blob) }));
  updateCount();
  toast(`Oldingi ${pages.length} ta sahifa tiklandi`);
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

async function savePage() {
  if (!current) return;
  const c = current;
  current = null; raw = null;
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', JPEG_Q));
  pages.push({ id: Date.now() + Math.random(), blob, url: URL.createObjectURL(blob), w: c.width, h: c.height });
  lastPdf = null;
  updateCount();
  store.save();
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
}

function renderGallery() {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!pages.length) {
    grid.innerHTML = '<div class="empty">Hali sahifa yo‘q. «Davom ettirish»ni bosib, sahifalarni suratga oling.</div>';
  }
  pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `<img src="${p.url}" alt="${i + 1}-sahifa"><span class="num">${i + 1}</span>
      <div class="acts">
        <button data-act="left" title="Oldinga" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button data-act="del" class="del" title="O‘chirish">🗑</button>
        <button data-act="right" title="Orqaga" ${i === pages.length - 1 ? 'disabled' : ''}>▶</button>
      </div>`;
    el.querySelector('img').onclick = () => showViewer(p.url);
    el.querySelector('.acts').onclick = (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      if (act === 'del') {
        if (!confirm(`${i + 1}-sahifani o‘chirasizmi?`)) return;
        URL.revokeObjectURL(p.url);
        pages.splice(i, 1);
      } else {
        const j = act === 'left' ? i - 1 : i + 1;
        [pages[i], pages[j]] = [pages[j], pages[i]];
      }
      lastPdf = null;
      updateCount();
      store.save();
      renderGallery();
    };
    grid.appendChild(el);
  });
  $('#makePdf').disabled = !pages.length;
}

function showViewer(url) {
  const v = $('#viewer');
  v.querySelector('img').src = url;
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

function askPdfName() {
  if (!pages.length) { toast('Hali birorta ham sahifa saqlanmagan'); return; }
  const dlg = $('#pdfDialog');
  $('#dialogInfo').textContent = `${pages.length} ta sahifa bitta PDF faylga yig‘iladi.`;
  $('#pdfName').value = lastPdf ? lastPdf.name.replace(/\.pdf$/, '') : defaultName();
  dlg.returnValue = '';
  dlg.showModal();
  setTimeout(() => $('#pdfName').select(), 50);
}

$('#pdfDialog').addEventListener('close', () => {
  if ($('#pdfDialog').returnValue === 'ok') makePdf(cleanName($('#pdfName').value));
});

async function makePdf(name) {
  toast('PDF tayyorlanmoqda…');
  const { jsPDF } = window.jspdf;
  let doc;
  for (const [i, p] of pages.entries()) {
    const w = 210, h = (210 * p.h) / p.w;                 // eni A4 (210 mm)
    const orient = h >= w ? 'p' : 'l';
    if (i === 0) doc = new jsPDF({ unit: 'mm', format: [w, h], orientation: orient, compress: true });
    else doc.addPage([w, h], orient);
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    doc.addImage(bytes, 'JPEG', 0, 0, w, h, undefined, 'FAST');
  }
  lastPdf = { blob: doc.output('blob'), name: name + '.pdf' };
  download();
  $('#doneTitle').textContent = `${pages.length} sahifali PDF tayyor`;
  $('#doneName').value = name;
  setState('done');
}

function download() {
  if (!lastPdf) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastPdf.blob);
  a.download = lastPdf.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Yuklandi: ${lastPdf.name}`);
}

function renamedPdf() {
  if (lastPdf) lastPdf.name = cleanName($('#doneName').value) + '.pdf';
  return lastPdf;
}

async function share() {
  const pdf = renamedPdf();
  const file = new File([pdf.blob], pdf.name, { type: 'application/pdf' });
  try { await navigator.share({ files: [file], title: pdf.name }); } catch (e) { /* bekor qilindi */ }
}

function newBook() {
  if (pages.length && !confirm('Barcha saqlangan sahifalar o‘chiriladi. Yangi kitobni boshlaysizmi?')) return;
  pages.forEach((p) => URL.revokeObjectURL(p.url));
  pages = []; lastPdf = null;
  updateCount();
  store.save();
  backToLive();
}

// ---------------------------------------------------------------- Yordamchilar
function setState(s) {
  app.dataset.state = s;
  if (s === 'live') { setMsg(''); drawOverlay(null); }
}
function updateCount() {
  $('#count').textContent = `${pages.length} sahifa`;
  $('#galleryCount').textContent = pages.length;
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
  toast(`${pages.length}-sahifa saqlandi. Keyingisini ko‘rsating`);
};
$('#retake').onclick = () => { current = null; raw = null; backToLive(); };
$('#rotate').onclick = () => { rotation = (rotation + 1) % 4; render(); };
$('#openGallery').onclick = openGallery;
$('#count').onclick = () => app.dataset.state === 'live' && openGallery();
$('#backToCam').onclick = backToLive;
$('#makePdf').onclick = askPdfName;
$('#download').onclick = () => { renamedPdf(); download(); };
$('#doneBack').onclick = openGallery;
$('#newBook').onclick = newBook;
$('#switchCam').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
if (navigator.canShare && navigator.canShare({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] })) {
  $('#share').hidden = false;
  $('#share').onclick = share;
}

$('#modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mode = b.dataset.mode;
  document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b));
  if (app.dataset.state === 'review' && raw) render();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const s = app.dataset.state;
  if (e.code === 'Space' && s === 'live') { e.preventDefault(); capture(); }
  else if (e.key === 'Enter' && s === 'review') $('#next').click();
  else if (e.key === 'Escape' && s === 'review') $('#retake').click();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!stream || !stream.active)) startCamera();
});

restorePages();
startCamera();
liveLoop();
