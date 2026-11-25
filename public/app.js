(() => {
  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const CONCURRENCY = 3;
  const ACCEPTED_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'svg'];

  const TOOLS = {
    convert: {
      title: 'Convert images',
      desc: 'Change JPG, PNG, WebP, AVIF, GIF, TIFF and SVG files into another format. Add one image or a whole batch.',
      action: 'Convert',
      busy: 'Converting',
      zipName: 'converted',
    },
    compress: {
      title: 'Compress images',
      desc: 'Make JPG, PNG, WebP, AVIF and GIF files smaller while keeping them looking sharp. Optionally resize them too.',
      action: 'Compress',
      busy: 'Compressing',
      zipName: 'compressed',
    },
    resize: {
      title: 'Resize images',
      desc: 'Change the size of JPG, PNG, WebP, AVIF, GIF and TIFF images by pixels or percentage, without losing quality.',
      action: 'Resize',
      busy: 'Resizing',
      zipName: 'resized',
    },
  };

  const FORMAT_NOTES = {
    jpeg: 'Best for photos. No transparency.',
    png: 'Lossless and keeps transparency. Files can be large.',
    webp: 'Small files, keeps transparency and animation. Works in all modern browsers.',
    avif: 'Smallest files for photos. Encoding takes a little longer.',
    gif: 'Keeps animation, but is limited to 256 colours.',
    tiff: 'Lossless, for print and archiving. Files are large.',
  };
  const LOSSY = new Set(['jpeg', 'webp', 'avif']);

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const els = {
    tabs: document.querySelectorAll('.tab'),
    title: $('#tool-title'),
    desc: $('#tool-desc'),
    dropzone: $('#dropzone'),
    input: $('#file-input'),
    workspace: $('#workspace'),
    list: $('#file-list'),
    count: $('#file-count'),
    clear: $('#clear-btn'),
    rowTpl: $('#file-row'),
    optGroups: document.querySelectorAll('.opt-group[data-for]'),
    formatPicker: $('#format-picker'),
    formatNote: $('#format-note'),
    convertQualityGroup: $('#convert-quality-group'),
    convertQuality: $('#convert-quality'),
    convertQualityOut: $('#convert-quality-out'),
    bgGroup: $('#bg-group'),
    bgColor: $('#bg-color'),
    presetPicker: $('#preset-picker'),
    customQuality: $('#custom-quality'),
    compressQuality: $('#compress-quality'),
    compressQualityOut: $('#compress-quality-out'),
    compressFormat: $('#compress-format'),
    maxWidth: $('#max-width'),
    maxHeight: $('#max-height'),
    resizeBy: $('#resize-by'),
    resizePixels: $('#resize-pixels'),
    resizePercent: $('#resize-percent'),
    resizeWidth: $('#resize-width'),
    resizeHeight: $('#resize-height'),
    resizeFit: $('#resize-fit'),
    percentPicker: $('#percent-picker'),
    percentInput: $('#resize-percent-input'),
    noEnlarge: $('#resize-no-enlarge'),
    resizeFormat: $('#resize-format'),
    runError: $('#run-error'),
    run: $('#run-btn'),
    doneActions: $('#done-actions'),
    summary: $('#summary'),
    zip: $('#zip-btn'),
    restart: $('#restart-btn'),
  };

  // ---------- State ----------
  const state = {
    tool: 'convert',
    format: 'jpeg',
    level: 'recommended', // light | recommended | strong | custom
    resizeBy: 'pixels', // pixels | percent
    fit: 'keep', // keep | crop | stretch
    running: false,
    items: [], // { id, file, previewUrl, width, height, status, result, error, el }
  };
  let nextId = 1;

  // ---------- Helpers ----------
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
  }

  function extOf(name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function labelFor(ext) {
    if (ext === 'jpeg') return 'JPG';
    if (ext === 'tif') return 'TIFF';
    return ext.toUpperCase();
  }

  function isAccepted(file) {
    return file.type.startsWith('image/') || ACCEPTED_EXT.includes(extOf(file.name));
  }

  function uniqueNames(names) {
    const seen = new Map();
    return names.map((name) => {
      const count = seen.get(name) || 0;
      seen.set(name, count + 1);
      if (count === 0) return name;
      const dot = name.lastIndexOf('.');
      return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
    });
  }

  // ---------- Tool switching ----------
  function setTool(tool) {
    if (!TOOLS[tool] || state.running) return;
    state.tool = tool;
    const t = TOOLS[tool];

    els.tabs.forEach((tab) => {
      const on = tab.dataset.tool === tool;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    els.title.textContent = t.title;
    els.desc.textContent = t.desc;
    document.title = `${t.title} | Pixelpress`;
    els.optGroups.forEach((g) => (g.hidden = g.dataset.for !== tool));
    if (location.hash !== `#${tool}`) history.replaceState(null, '', `#${tool}`);

    updateConvertOptions();
    updateResizeOptions();
    resetResults();
  }

  // ---------- Options ----------
  function updateConvertOptions() {
    if (state.tool !== 'convert') return;
    els.formatPicker.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.format === state.format;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
    els.formatNote.textContent = FORMAT_NOTES[state.format];
    els.convertQualityGroup.hidden = !LOSSY.has(state.format);
    els.bgGroup.hidden = state.format !== 'jpeg';
  }

  function selectLevel(level) {
    state.level = level;
    els.presetPicker.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.level === level;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
    els.customQuality.hidden = level !== 'custom';
  }

  function setRadio(group, attr, value) {
    group.querySelectorAll(`button[data-${attr}]`).forEach((b) => {
      const on = b.dataset[attr] === value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function updateResizeOptions() {
    if (state.tool !== 'resize') return;
    setRadio(els.resizeBy, 'by', state.resizeBy);
    setRadio(els.resizeFit, 'fit', state.fit);
    setRadio(els.percentPicker, 'percent', els.percentInput.value);
    els.resizePixels.hidden = state.resizeBy !== 'pixels';
    els.resizePercent.hidden = state.resizeBy !== 'percent';
    updateDimensionHints();
  }

  // With one image and "keep proportions", show the size the other side will get.
  function updateDimensionHints() {
    const valid = state.items.filter((i) => i.status !== 'error' || i.result);
    const only = valid.length === 1 && valid[0].width ? valid[0] : null;
    const w = Number(els.resizeWidth.value);
    const h = Number(els.resizeHeight.value);
    let wHint = 'Auto';
    let hHint = 'Auto';
    if (only && state.fit === 'keep') {
      if (w && !h) hHint = String(Math.max(1, Math.round((w * only.height) / only.width)));
      if (h && !w) wHint = String(Math.max(1, Math.round((h * only.width) / only.height)));
      if (!w && !h) {
        wHint = String(only.width);
        hHint = String(only.height);
      }
    }
    if (state.fit !== 'keep') wHint = hHint = 'Required';
    els.resizeWidth.placeholder = wHint;
    els.resizeHeight.placeholder = hHint;
  }

  /** Returns a message when the current resize settings can't run, otherwise ''. */
  function resizeProblem() {
    if (state.tool !== 'resize') return '';
    if (state.resizeBy === 'percent') {
      const p = Number(els.percentInput.value);
      return p > 0 && p <= 400 ? '' : 'Enter a percentage between 1 and 400.';
    }
    const w = Number(els.resizeWidth.value);
    const h = Number(els.resizeHeight.value);
    if ((w && (w < 1 || w > 10000)) || (h && (h < 1 || h > 10000))) return 'Sizes must be between 1 and 10,000 px.';
    if (state.fit === 'keep') return w || h ? '' : 'Enter a width, a height, or both.';
    return w && h ? '' : 'Enter both a width and a height to crop or stretch.';
  }

  function buildFormData(item) {
    const fd = new FormData();
    fd.append('file', item.file, item.file.name);
    if (state.tool === 'convert') {
      fd.append('format', state.format);
      fd.append('quality', els.convertQuality.value);
      fd.append('background', els.bgColor.value);
    } else if (state.tool === 'resize') {
      fd.append('format', els.resizeFormat.value);
      fd.append('by', state.resizeBy);
      fd.append('enlarge', String(!els.noEnlarge.checked));
      if (state.resizeBy === 'percent') {
        fd.append('percent', els.percentInput.value);
      } else {
        fd.append('fit', state.fit);
        if (els.resizeWidth.value) fd.append('width', els.resizeWidth.value);
        if (els.resizeHeight.value) fd.append('height', els.resizeHeight.value);
      }
    } else {
      fd.append('format', els.compressFormat.value);
      if (state.level === 'custom') fd.append('quality', els.compressQuality.value);
      else fd.append('level', state.level);
      if (els.maxWidth.value) fd.append('maxWidth', els.maxWidth.value);
      if (els.maxHeight.value) fd.append('maxHeight', els.maxHeight.value);
    }
    return fd;
  }

  // ---------- Files ----------
  function addFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;

    for (const file of files) {
      const item = {
        id: nextId++,
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'ready',
        result: null,
        error: '',
        el: null,
      };
      if (!isAccepted(file)) {
        item.status = 'error';
        item.error = 'Not a supported image type';
      } else if (file.size > MAX_FILE_SIZE) {
        item.status = 'error';
        item.error = 'Larger than 25 MB';
      }
      item.el = createRow(item);
      els.list.appendChild(item.el);
      state.items.push(item);
      renderItem(item);
    }
    render();
  }

  function createRow(item) {
    const row = els.rowTpl.content.firstElementChild.cloneNode(true);
    const img = row.querySelector('img');
    const ext = extOf(item.file.name);
    row.querySelector('.thumb-ext').textContent = labelFor(ext || '?');
    img.hidden = true;
    img.addEventListener('load', () => {
      img.hidden = false;
      item.width = img.naturalWidth;
      item.height = img.naturalHeight;
      renderItem(item);
      updateDimensionHints();
    });
    img.addEventListener('error', () => (img.hidden = true));
    img.src = item.previewUrl;
    row.querySelector('.file-name').textContent = item.file.name;
    row.querySelector('.file-name').title = item.file.name;
    row.querySelector('.remove').addEventListener('click', () => removeItem(item.id));
    return row;
  }

  function removeItem(id) {
    if (state.running) return;
    const idx = state.items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [item] = state.items.splice(idx, 1);
    releaseItem(item);
    item.el.remove();
    updateDimensionHints();
    render();
  }

  function releaseItem(item) {
    URL.revokeObjectURL(item.previewUrl);
    if (item.result) URL.revokeObjectURL(item.result.url);
  }

  function clearAll() {
    if (state.running) return;
    state.items.forEach(releaseItem);
    state.items = [];
    els.list.innerHTML = '';
    render();
  }

  // Options changed or tool switched: previous outputs no longer match the settings.
  function resetResults() {
    if (state.running) return;
    for (const item of state.items) {
      if (item.status === 'done') {
        URL.revokeObjectURL(item.result.url);
        item.result = null;
        item.status = 'ready';
      } else if (item.status === 'error' && item.file.size <= MAX_FILE_SIZE && isAccepted(item.file)) {
        item.status = 'ready';
        item.error = '';
      }
      renderItem(item);
    }
    render();
  }

  // ---------- Processing ----------
  async function processItem(item) {
    item.status = 'working';
    renderItem(item);
    try {
      const res = await fetch(`/api/${state.tool}`, { method: 'POST', body: buildFormData(item) });
      if (!res.ok) {
        let message = `Failed (${res.status})`;
        try {
          message = (await res.json()).error || message;
        } catch {
          /* not JSON */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Filename') || item.file.name);
      item.result = {
        blob,
        url: URL.createObjectURL(blob),
        name,
        size: blob.size,
        originalSize: Number(res.headers.get('X-Original-Size')) || item.file.size,
        note: res.headers.get('X-Note') || '',
        qualityUsed: Number(res.headers.get('X-Quality')) || 0,
        width: Number(res.headers.get('X-Width')) || 0,
        height: Number(res.headers.get('X-Height')) || 0,
        originalWidth: Number(res.headers.get('X-Original-Width')) || 0,
        originalHeight: Number(res.headers.get('X-Original-Height')) || 0,
      };
      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      item.error = err.message === 'Failed to fetch' ? 'Could not reach the server' : err.message;
    }
    renderItem(item);
  }

  async function runAll() {
    const queue = state.items.filter((i) => i.status === 'ready');
    if (!queue.length || state.running) return;
    state.running = true;
    render();

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) await processItem(queue.shift());
    });
    await Promise.all(workers);

    state.running = false;
    render();
  }

  async function downloadZip() {
    const done = state.items.filter((i) => i.status === 'done');
    if (!done.length) return;
    if (done.length === 1) {
      triggerDownload(done[0].result.url, done[0].result.name);
      return;
    }
    els.zip.disabled = true;
    els.zip.textContent = 'Preparing zip…';
    try {
      const names = uniqueNames(done.map((i) => i.result.name));
      const zip = await window.makeZip(done.map((i, n) => ({ name: names[n], blob: i.result.blob })));
      const url = URL.createObjectURL(zip);
      triggerDownload(url, `pixelpress-${TOOLS[state.tool].zipName}.zip`);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } finally {
      els.zip.disabled = false;
      render();
    }
  }

  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- Rendering ----------
  function renderItem(item) {
    const meta = item.el.querySelector('.file-meta');
    const status = item.el.querySelector('.file-status');
    const remove = item.el.querySelector('.remove');
    status.replaceChildren();
    remove.disabled = state.running;

    const inLabel = labelFor(extOf(item.file.name) || 'file');
    const dims = item.width ? ` · ${item.width}×${item.height}` : '';

    if (item.status === 'working') {
      meta.textContent = `${formatBytes(item.file.size)} · ${inLabel}${dims}`;
      const spin = document.createElement('span');
      spin.className = 'spinner';
      spin.setAttribute('aria-label', 'Processing');
      status.append(spin);
      return;
    }

    if (item.status === 'error') {
      meta.textContent = `${formatBytes(item.file.size)} · ${inLabel}${dims}`;
      const err = document.createElement('span');
      err.className = 'status-error';
      err.textContent = item.error;
      status.append(err);
      return;
    }

    if (item.status === 'done') {
      const r = item.result;
      const outLabel = labelFor(extOf(r.name));
      let metaText = `${formatBytes(r.originalSize)} → ${formatBytes(r.size)} · ${outLabel}`;
      if (state.tool === 'compress' && r.qualityUsed) metaText += ` · quality ${r.qualityUsed}`;
      if (state.tool === 'resize' && r.width) {
        metaText = `${r.originalWidth}×${r.originalHeight} → ${r.width}×${r.height} · ${formatBytes(r.size)} · ${outLabel}`;
      }
      if (r.note === 'already-optimized') {
        metaText = `${formatBytes(r.originalSize)} · already compressed, original kept`;
      }
      meta.textContent = metaText;

      const badge = document.createElement('span');
      const change = (r.size - r.originalSize) / r.originalSize;
      if (r.note === 'already-optimized') {
        badge.className = 'badge flat';
        badge.textContent = 'No saving';
        badge.title = 'This image was already compressed. Making it smaller would visibly lower its quality, so the original was kept. Try the Strong level or a smaller size.';
      } else if (Math.abs(change) < 0.005) {
        badge.className = 'badge flat';
        badge.textContent = '0%';
      } else {
        badge.className = `badge ${change < 0 ? 'good' : 'bad'}`;
        badge.textContent = `${change < 0 ? '−' : '+'}${Math.round(Math.abs(change) * 100)}%`;
      }

      const link = document.createElement('a');
      link.className = 'download';
      link.href = r.url;
      link.download = r.name;
      link.textContent = 'Download';
      status.append(badge, link);
      return;
    }

    meta.textContent = `${formatBytes(item.file.size)} · ${inLabel}${dims}`;
  }

  // Suggest the next thing to try when compression saved little.
  function suggestStronger() {
    const tips = [];
    if (state.level === 'light' || state.level === 'recommended') tips.push('the <strong>Strong</strong> level');
    if (!els.maxWidth.value && !els.maxHeight.value) tips.push('a smaller size');
    if (!tips.length) return '';
    const list = tips.length > 1 ? `${tips.slice(0, -1).join(', ')} or ${tips.at(-1)}` : tips[0];
    return `For smaller files, try ${list}.`;
  }

  function render() {
    const items = state.items;
    const hasItems = items.length > 0;
    els.dropzone.hidden = hasItems;
    els.workspace.hidden = !hasItems;
    els.count.textContent = String(items.length);
    els.count.nextSibling.textContent = items.length === 1 ? ' image' : ' images';

    const ready = items.filter((i) => i.status === 'ready').length;
    const done = items.filter((i) => i.status === 'done');
    const action = TOOLS[state.tool].action;

    const problem = resizeProblem();
    els.run.hidden = !state.running && ready === 0;
    els.run.disabled = state.running || Boolean(problem);
    els.runError.hidden = !problem || els.run.hidden;
    els.runError.textContent = problem;
    els.run.textContent = state.running
      ? `${TOOLS[state.tool].busy}…`
      : `${action} ${ready === 1 ? 'image' : `${ready} images`}`;

    const finished = !state.running && ready === 0 && done.length > 0;
    els.doneActions.hidden = !finished;
    if (finished) {
      const before = done.reduce((s, i) => s + i.result.originalSize, 0);
      const after = done.reduce((s, i) => s + i.result.size, 0);
      const word = done.length === 1 ? 'image' : 'images';
      if (state.tool === 'compress') {
        const saved = before - after;
        const pct = before ? saved / before : 0;
        const hint = suggestStronger();
        if (pct >= 0.01) {
          els.summary.innerHTML = `Saved <strong>${formatBytes(saved)}</strong> (${Math.round(pct * 100)}%) across ${done.length} ${word}.`;
          if (pct < 0.1 && hint) els.summary.innerHTML += ` ${hint}`;
        } else {
          els.summary.innerHTML =
            `${done.length === 1 ? 'This image was' : 'These images were'} already compressed, so there was little to save.` +
            (hint ? ` ${hint}` : '');
        }
      } else if (state.tool === 'resize') {
        els.summary.innerHTML = `Resized <strong>${done.length}</strong> ${word}. Total size ${formatBytes(after)}.`;
      } else {
        els.summary.innerHTML = `Converted <strong>${done.length}</strong> ${word}. Total size ${formatBytes(after)}.`;
      }
      els.zip.textContent = done.length === 1 ? 'Download' : 'Download all (.zip)';
    }

    els.clear.disabled = state.running;
    els.tabs.forEach((t) => (t.disabled = state.running));
    items.forEach((i) => (i.el.querySelector('.remove').disabled = state.running));
  }

  // ---------- Events ----------
  els.tabs.forEach((tab) => tab.addEventListener('click', () => setTool(tab.dataset.tool)));

  els.input.addEventListener('change', () => {
    addFiles(els.input.files);
    els.input.value = '';
  });

  // Allow dropping anywhere on the page, not just the drop zone.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    els.dropzone.classList.add('is-over');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropzone.classList.remove('is-over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropzone.classList.remove('is-over');
    if (!state.running && e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  });

  els.clear.addEventListener('click', clearAll);
  els.restart.addEventListener('click', clearAll);
  els.run.addEventListener('click', runAll);
  els.zip.addEventListener('click', downloadZip);

  els.formatPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-format]');
    if (!btn || state.running) return;
    state.format = btn.dataset.format;
    updateConvertOptions();
    resetResults();
  });

  els.convertQuality.addEventListener('input', () => {
    els.convertQualityOut.textContent = els.convertQuality.value;
  });

  els.presetPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-level]');
    if (!btn || state.running || btn.dataset.level === state.level) return;
    selectLevel(btn.dataset.level);
    resetResults();
  });

  els.compressQuality.addEventListener('input', () => {
    els.compressQualityOut.textContent = els.compressQuality.value;
  });

  els.resizeBy.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-by]');
    if (!btn || state.running || btn.dataset.by === state.resizeBy) return;
    state.resizeBy = btn.dataset.by;
    updateResizeOptions();
    resetResults();
  });

  els.resizeFit.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fit]');
    if (!btn || state.running || btn.dataset.fit === state.fit) return;
    state.fit = btn.dataset.fit;
    updateResizeOptions();
    resetResults();
  });

  els.percentPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-percent]');
    if (!btn || state.running) return;
    els.percentInput.value = btn.dataset.percent;
    updateResizeOptions();
    resetResults();
  });

  // Typing updates validation and hints immediately. Results reset on change.
  [els.resizeWidth, els.resizeHeight, els.percentInput].forEach((el) =>
    el.addEventListener('input', () => {
      if (el === els.percentInput) setRadio(els.percentPicker, 'percent', el.value);
      updateDimensionHints();
      render();
    })
  );

  // Any settings change invalidates finished results.
  [
    els.convertQuality,
    els.bgColor,
    els.compressQuality,
    els.compressFormat,
    els.maxWidth,
    els.maxHeight,
    els.resizeWidth,
    els.resizeHeight,
    els.percentInput,
    els.noEnlarge,
    els.resizeFormat,
  ].forEach(
    (el) => el.addEventListener('change', resetResults)
  );

  // ---------- Init ----------
  const initial = location.hash.slice(1);
  setTool(TOOLS[initial] ? initial : 'convert');
})();
