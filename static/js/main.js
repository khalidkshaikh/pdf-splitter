/* =====================================================
   PDF Splitter — main.js
   Modes:
     all    — every page → separate PDF download
     range  — parse "1-3, 5, 7-9" → one PDF per range
     select — click page thumbnails → one PDF with chosen pages
   ===================================================== */

// ── PDF.js worker ──────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ──────────────────────────────────────────────
let currentFile   = null;
let pdfJsDoc      = null;
let pdfLibDoc     = null;
let numPages      = 0;
let splitMode     = 'all';    // 'all' | 'range' | 'select'
let selectedPages = new Set();
let isSplitting   = false;
let globalDragCounter = 0;
let isFileDragging    = false;

// ── DOM refs ───────────────────────────────────────────
const fileInput        = document.getElementById('fileInput');
const dropZone         = document.getElementById('dropZone');
const uploadCard       = document.getElementById('uploadCard');
const splitSection     = document.getElementById('splitSection');
const fileNameEl       = document.getElementById('fileName');
const fileMetaEl       = document.getElementById('fileMeta');
const swapFileBtn      = document.getElementById('swapFileBtn');
const rangeInputWrap   = document.getElementById('rangeInputWrap');
const rangeInput       = document.getElementById('rangeInput');
const rangeHint        = document.getElementById('rangeHint');
const thumbGrid        = document.getElementById('thumbGrid');
const actionSummary    = document.getElementById('actionSummary');
const splitBtn         = document.getElementById('splitBtn');
const clearBtn         = document.getElementById('clearBtn');
const progressTrack    = document.getElementById('progressTrack');
const progressFill     = document.getElementById('progressFill');
const globalDropOverlay = document.getElementById('globalDropOverlay');

// ── Service Worker ─────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/pdf-splitter/sw.js')
            .then(reg => {
                if (reg.active) showSwBadge();
                reg.addEventListener('updatefound', () => {
                    reg.installing?.addEventListener('statechange', e => {
                        if (e.target.state === 'activated') showSwBadge();
                    });
                });
            }).catch(() => {});
    });
}
function showSwBadge() {
    const li = document.getElementById('swBadgeLi');
    if (li) li.style.display = '';
}

// ── Mode buttons ───────────────────────────────────────
document.querySelectorAll('.quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        splitMode = btn.dataset.mode;
        updateModeUI();
        updateSummary();
    });
});

function updateModeUI() {
    rangeInputWrap.style.display = splitMode === 'range'  ? '' : 'none';
    thumbGrid.style.display      = splitMode === 'select' ? '' : 'none';
    if (splitMode === 'select' && thumbGrid.childElementCount === 0 && pdfJsDoc) {
        renderThumbnails();
    }
}

// ── File input ─────────────────────────────────────────
fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
});
swapFileBtn.addEventListener('click', () => {
    resetTool();
    fileInput.click();
});

// ── Drop zone ──────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    hideDropOverlay();
    const f = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (f) loadFile(f);
});

// ── Global drag ────────────────────────────────────────
document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    isFileDragging = true;
    globalDragCounter++;
    if (globalDragCounter === 1) showDropOverlay();
});
document.addEventListener('dragleave', () => {
    if (!isFileDragging) return;
    globalDragCounter--;
    if (globalDragCounter <= 0) { globalDragCounter = 0; hideDropOverlay(); }
});
document.addEventListener('dragover', e => { if (isFileDragging) e.preventDefault(); });
document.addEventListener('drop', e => {
    if (!isFileDragging) return;
    e.preventDefault();
    if (!dropZone.contains(e.target)) {
        const f = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
        if (f) loadFile(f);
    }
    globalDragCounter = 0;
    isFileDragging = false;
    hideDropOverlay();
});
document.addEventListener('dragend', () => { globalDragCounter = 0; isFileDragging = false; hideDropOverlay(); });

function showDropOverlay() { globalDropOverlay.classList.add('active'); }
function hideDropOverlay() { globalDropOverlay.classList.remove('active'); isFileDragging = false; globalDragCounter = 0; }

// ── Range input live validation ────────────────────────
rangeInput.addEventListener('input', () => {
    const result = parseRanges(rangeInput.value, numPages);
    if (!rangeInput.value.trim()) {
        rangeHint.textContent = '';
        rangeHint.className = 'range-hint';
        splitBtn.disabled = true;
        return;
    }
    if (result.error) {
        rangeHint.textContent = result.error;
        rangeHint.className = 'range-hint invalid';
        splitBtn.disabled = true;
    } else {
        rangeHint.textContent = `${result.groups.length} output PDF${result.groups.length !== 1 ? 's' : ''}`;
        rangeHint.className = 'range-hint valid';
        splitBtn.disabled = false;
    }
    updateSummary();
});

// ── Clear / Split buttons ──────────────────────────────
clearBtn.addEventListener('click', resetTool);
splitBtn.addEventListener('click', doSplit);

// ── Load file ──────────────────────────────────────────
async function loadFile(file) {
    if (!file) return;
    currentFile = file;
    uploadCard.style.display = 'none';

    fileNameEl.textContent = file.name;
    fileMetaEl.textContent = 'Loading…';
    splitSection.style.display = '';
    splitBtn.disabled = true;
    actionSummary.textContent = 'Loading…';

    try {
        const arrayBuffer = await file.arrayBuffer();
        pdfJsDoc  = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
        pdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer);
        numPages  = pdfJsDoc.numPages;

        fileMetaEl.textContent = `${numPages} page${numPages !== 1 ? 's' : ''} · ${formatSize(file.size)}`;

        selectedPages = new Set();
        thumbGrid.innerHTML = '';

        updateModeUI();
        updateSummary();
        if (splitMode !== 'range') splitBtn.disabled = false;
    } catch (err) {
        fileMetaEl.textContent = 'Failed to load PDF';
        console.error(err);
    }
}

// ── Render thumbnails ──────────────────────────────────
async function renderThumbnails() {
    thumbGrid.innerHTML = '';
    for (let p = 1; p <= numPages; p++) {
        const item = document.createElement('div');
        item.className = 'thumb-item';
        item.dataset.page = p;

        const canvas = document.createElement('canvas');
        const check  = document.createElement('div');
        check.className = 'thumb-check';
        check.innerHTML = '<i class="bi bi-check"></i>';
        const label = document.createElement('div');
        label.className = 'thumb-label';
        label.textContent = `Page ${p}`;

        item.appendChild(canvas);
        item.appendChild(check);
        item.appendChild(label);
        thumbGrid.appendChild(item);

        item.addEventListener('click', () => {
            if (selectedPages.has(p)) {
                selectedPages.delete(p);
                item.classList.remove('selected');
            } else {
                selectedPages.add(p);
                item.classList.add('selected');
            }
            updateSummary();
            splitBtn.disabled = selectedPages.size === 0;
        });

        // Render async to avoid blocking
        renderThumb(p, canvas);
    }
}

async function renderThumb(pageNum, canvas) {
    try {
        const page     = await pdfJsDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.3 });
        canvas.width   = Math.round(viewport.width);
        canvas.height  = Math.round(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        page.cleanup();
    } catch (_) {}
}

// ── Update summary ─────────────────────────────────────
function updateSummary() {
    if (!numPages) return;
    if (splitMode === 'all') {
        actionSummary.textContent = `${numPages} output PDF${numPages !== 1 ? 's' : ''} (one per page)`;
    } else if (splitMode === 'range') {
        const result = parseRanges(rangeInput.value, numPages);
        if (result.error || !rangeInput.value.trim()) {
            actionSummary.textContent = 'Enter a page range above';
        } else {
            actionSummary.textContent = `${result.groups.length} output PDF${result.groups.length !== 1 ? 's' : ''}`;
        }
    } else {
        const n = selectedPages.size;
        actionSummary.textContent = n ? `${n} page${n !== 1 ? 's' : ''} selected → 1 output PDF` : 'Click pages to select';
    }
}

// ── Parse range string ─────────────────────────────────
// Returns { groups: [[1,2,3], [5], [7,8,9]] } or { error: string }
function parseRanges(str, maxPage) {
    if (!str.trim()) return { error: 'Empty' };
    const parts = str.split(',').map(s => s.trim()).filter(Boolean);
    const groups = [];
    for (const part of parts) {
        const m = part.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) return { error: `Invalid: "${part}"` };
        const from = parseInt(m[1]);
        const to   = m[2] ? parseInt(m[2]) : from;
        if (from < 1 || to > maxPage || from > to) {
            return { error: `Out of range: "${part}" (1-${maxPage})` };
        }
        const pages = [];
        for (let i = from; i <= to; i++) pages.push(i);
        groups.push(pages);
    }
    return { groups };
}

// ── Do split ───────────────────────────────────────────
async function doSplit() {
    if (isSplitting || !pdfLibDoc) return;
    isSplitting = true;
    splitBtn.disabled = true;
    clearBtn.disabled = true;
    splitBtn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Splitting…';

    const baseName = currentFile.name.replace(/\.pdf$/i, '');

    try {
        if (splitMode === 'all') {
            await splitAllPages(baseName);
        } else if (splitMode === 'range') {
            const result = parseRanges(rangeInput.value, numPages);
            if (!result.error) await splitByRanges(baseName, result.groups);
        } else {
            // select mode — one PDF with selected pages in order
            const pages = [...selectedPages].sort((a,b) => a-b);
            await splitToOnePdf(baseName + '_selected', pages);
        }
    } catch (err) {
        console.error(err);
    }

    setProgress(100);
    isSplitting = false;
    splitBtn.disabled = false;
    clearBtn.disabled = false;
    splitBtn.innerHTML = '<i class="bi bi-scissors me-2"></i>Split &amp; Download';
}

async function splitAllPages(baseName) {
    setProgress(5);
    for (let i = 0; i < numPages; i++) {
        setProgress(5 + Math.round((i / numPages) * 90));
        const outDoc = await PDFLib.PDFDocument.create();
        const [page] = await outDoc.copyPages(pdfLibDoc, [i]);
        outDoc.addPage(page);
        const bytes = await outDoc.save();
        downloadPdf(bytes, `${baseName}_page${i + 1}.pdf`);
        if (i < numPages - 1) await sleep(400);
    }
}

async function splitByRanges(baseName, groups) {
    setProgress(5);
    for (let g = 0; g < groups.length; g++) {
        setProgress(5 + Math.round((g / groups.length) * 90));
        const pages = groups[g];
        const outDoc = await PDFLib.PDFDocument.create();
        const indices = pages.map(p => p - 1);
        const copied = await outDoc.copyPages(pdfLibDoc, indices);
        copied.forEach(p => outDoc.addPage(p));
        const bytes = await outDoc.save();
        const label = pages.length === 1 ? `page${pages[0]}` : `pages${pages[0]}-${pages[pages.length-1]}`;
        downloadPdf(bytes, `${baseName}_${label}.pdf`);
        if (g < groups.length - 1) await sleep(400);
    }
}

async function splitToOnePdf(filename, pages) {
    setProgress(20);
    const outDoc = await PDFLib.PDFDocument.create();
    const indices = pages.map(p => p - 1);
    const copied = await outDoc.copyPages(pdfLibDoc, indices);
    copied.forEach(p => outDoc.addPage(p));
    setProgress(80);
    const bytes = await outDoc.save();
    downloadPdf(bytes, `${filename}.pdf`);
}

// ── Reset ──────────────────────────────────────────────
function resetTool() {
    currentFile   = null;
    pdfJsDoc      = null;
    pdfLibDoc     = null;
    numPages      = 0;
    selectedPages = new Set();
    thumbGrid.innerHTML = '';
    rangeInput.value = '';
    rangeHint.textContent = '';
    rangeHint.className = 'range-hint';
    uploadCard.style.display = '';
    splitSection.style.display = 'none';
    setProgress(0);
}

// ── Progress ───────────────────────────────────────────
function setProgress(pct) {
    if (pct <= 0) { progressTrack.style.display = 'none'; progressFill.style.width = '0%'; return; }
    progressTrack.style.display = 'block';
    progressFill.style.width = Math.min(pct, 100) + '%';
    if (pct >= 100) setTimeout(() => setProgress(0), 900);
}

// ── Utilities ──────────────────────────────────────────
function downloadPdf(bytes, filename) {
    const a = document.createElement('a');
    a.download = filename;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
