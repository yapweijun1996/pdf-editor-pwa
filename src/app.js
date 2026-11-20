import { documentState, edit, history, selectPages } from './model.js';
import { checkText, createPDF, describeFields, openPDF, previewFields, validateFields } from './pdf.js';
import { createViewer } from './viewer.js';

const $ = id => document.getElementById(id);
const sources = new Map();
const phoneLayout = matchMedia('(max-width: 768px)');
const sheet = $('tools-sheet');
const optionDisclosure = document.querySelector('#tool-options .mobile-disclosure input');
const phoneStatus = $('phone-status');
let fadeTimer, hideTimer;
// Reuse the same controls and listeners in the phone sheet and desktop groups.
const phoneControls = Object.entries({
  filename: document.querySelector('.masthead'),
  install: $('sheet-actions'), theme: $('sheet-actions'), open: $('sheet-actions'), 'confirm-save': $('sheet-actions'),
  'document-actions': $('sheet-document'), 'page-thumbnails': $('phone-pages'), 'page-operations': $('page-thumbnails'),
}).map(([id, destination]) => {
  const control = $(id), home = document.createComment(`Home: ${id}`);
  control.before(home);
  return { control, home, destination };
});
function syncPhoneLayout() {
  if (!phoneLayout.matches) {
    if (sheet.open) sheet.close();
    setImmersive(false);
    clearTimeout(fadeTimer);
    clearTimeout(hideTimer);
    phoneStatus.classList.remove('is-visible');
    phoneStatus.hidden = true;
  }
  for (const { control, home, destination } of phoneControls) {
    if (!phoneLayout.matches) home.after(control);
    else if (control.id === 'filename') destination.prepend(control);
    else destination.append(control);
  }
  controls();
}
$('more-tools').onclick = () => {
  if (anyDialog()) return;
  viewer.cancelGestures();
  cancelStroke();
  $('show-pages').checked = false;
  $('more-tools').focus({ preventScroll: true });
  syncSheetDetails();
  sheet.showModal();
};
sheet.addEventListener('click', event => {
  // Close before actions run: some open another modal or require a live user gesture.
  if (event.target.closest('#sheet-actions button, #sheet-document button')) sheet.close();
}, true);
phoneLayout.addEventListener('change', syncPhoneLayout);
let session, requestedState, baseId, selected = 0, serial = 0, zoom = 1, busy = false;
let mode = 'view', image, stroke, formSource, warned = false;
const colors = { text: '#15386a', ink: '#15386a', highlight: '#ffd12a' };
const viewer = createViewer({
  stage: $('stage'), paper: $('paper'), canvas: $('canvas'), overlay: $('overlay'), thumbs: $('thumbs'),
  getSource: id => sources.get(id), onSelect: (index, reveal) => go(index, reveal), onError: message => status(message, true),
  canTap: () => ready() && (mode === 'image' || (mode === 'text' && Boolean($('mark-text').value.trim()))),
  canViewTap: () => ready() && phoneLayout.matches && mode === 'view',
  canPinch: () => ready(),
  onTap: (x, y) => place(viewer.point(x, y)),
  onViewTap: () => setImmersive(!document.body.classList.contains('immersive')),
  onPinch: (ratio, anchor) => adjustZoom(zoom * ratio, anchor),
  isPhone: () => phoneLayout.matches,
  canPan: () => ready() && !['ink', 'highlight'].includes(mode),
  onMultitouch: cancelStroke,
});

function cancelStroke() {
  if (!stroke) return;
  stroke = undefined;
  viewer.paint();
}

function setImmersive(enabled) {
  if (enabled) {
    $('show-pages').checked = false;
    $('stage').focus({ preventScroll: true });
  }
  document.body.classList.toggle('immersive', enabled);
  const toggleHint = enabled ? 'Tap or press Enter to show controls.' : 'Tap or press Enter in View mode to hide controls.';
  $('stage').setAttribute('aria-label', `Page viewer. Use Left and Right arrows to change pages.${phoneLayout.matches ? ` ${toggleHint}` : ''}`);
}

function syncSheetDetails() {
  $('sheet-details').textContent = [$('dirty').textContent, $('offline').textContent].filter(Boolean).join(' · ');
}

const pageSummary = () => session ? `Page ${selected + 1} of ${session.current.pages.length}` : '';
function showPhoneStatus(message, error) {
  if (!phoneLayout.matches) return;
  const saveState = session ? session.dirty ? 'Unsaved edits' : 'No unsaved edits' : '';
  phoneStatus.textContent = [pageSummary(), saveState, message].filter(Boolean).join(' · ');
  phoneStatus.dataset.error = error;
  phoneStatus.hidden = false;
  phoneStatus.classList.add('is-visible');
  clearTimeout(fadeTimer);
  clearTimeout(hideTimer);
  fadeTimer = setTimeout(() => {
    phoneStatus.classList.remove('is-visible');
    hideTimer = setTimeout(() => { phoneStatus.hidden = true; }, 240);
  }, 2000);
}

function status(message, error = false) {
  for (const id of ['status', 'sheet-status']) {
    $(id).textContent = message;
    $(id).dataset.error = error;
  }
  showPhoneStatus(message, error);
}
const activePage = () => session?.current.pages[selected];
const anyDialog = () => Boolean(document.querySelector('dialog[open]'));
const ready = () => session && !busy && !anyDialog();
const canConfirmSave = () => session?.dirty && session.current === requestedState;
const warnBeforeUnload = event => { event.preventDefault(); event.returnValue = true; };

function controls() {
  const hasDocument = Boolean(session);
  const count = session?.current.pages.length ?? 0;
  $('welcome').hidden = hasDocument;
  $('workspace').hidden = !hasDocument;
  const filename = sources.get(baseId)?.name ?? 'No document open';
  $('filename').textContent = filename;
  $('filename').title = filename;
  $('sheet-document').hidden = !hasDocument;
  $('page-number').max = count;
  $('page-number').value = selected + 1;
  $('page-count').textContent = `of ${count}`;
  if (phoneLayout.matches && count) $('page-number').setAttribute('aria-valuetext', pageSummary());
  else $('page-number').removeAttribute('aria-valuetext');
  $('dirty').textContent = session?.dirty ? 'Unsaved edits' : '';
  if (phoneLayout.matches) syncSheetDetails();
  $('confirm-save').hidden = !canConfirmSave();
  $('confirm-save').disabled = busy;
  if (warned !== Boolean(session?.dirty)) {
    warned = Boolean(session?.dirty);
    if (warned) window.addEventListener('beforeunload', warnBeforeUnload);
    else window.removeEventListener('beforeunload', warnBeforeUnload);
  }
  for (const id of ['open', 'start']) $(id).disabled = busy;
  for (const id of ['save', 'forms', 'merge', 'extract', 'rotate', 'page-number', 'zoom-fit']) $(id).disabled = busy || !hasDocument;
  const percent = `${Math.round(zoom * 100)}%`;
  $('zoom-fit').textContent = zoom === 1 ? 'Fit' : phoneLayout.matches ? percent : `${percent} of fit`;
  $('zoom-in').disabled = busy || zoom >= 3;
  $('zoom-out').disabled = busy || zoom <= .5;
  $('undo').disabled = busy || !session?.canUndo;
  $('redo').disabled = busy || !session?.canRedo;
  $('prev').disabled = $('earlier').disabled = busy || selected === 0;
  $('next').disabled = $('later').disabled = busy || selected >= count - 1;
  $('delete').disabled = busy || count < 2;
}

function lock(value) {
  busy = value;
  if (busy) viewer.cancelGestures();
  controls();
}
function refresh({ render = true, reset = false, reveal = false, anchor } = {}) {
  controls();
  if (!session) return;
  viewer.list(session.current.pages, selected, reveal);
  if (render) {
    stroke = undefined;
    void viewer.show(activePage(), zoom, reset, anchor);
  } else viewer.update(activePage());
}
function go(index, reveal = true) {
  if (!ready() || !Number.isInteger(index)) { controls(); return; }
  selected = Math.max(0, Math.min(index, session.current.pages.length - 1));
  refresh({ reset: true, reveal });
  if (phoneLayout.matches) {
    $('status').textContent = pageSummary();
    $('status').dataset.error = false;
    showPhoneStatus('', false);
  }
}
function retainSelection(id) {
  const pages = session.current.pages;
  const at = pages.findIndex(page => page.id === id);
  selected = at < 0 ? Math.min(selected, pages.length - 1) : at;
}
function pruneSources() {
  for (const [id, source] of sources) {
    if (id !== baseId && !session.referencesSource(id)) {
      sources.delete(id);
      void source.destroy().catch(() => {});
    }
  }
}
function change(action, message, render = true) {
  const id = activePage()?.id;
  if (!session.apply(action)) return false;
  retainSelection(id);
  refresh({ render, reveal: render });
  pruneSources();
  status(message);
  return true;
}

async function historyStep(direction) {
  if (!ready()) return;
  const id = activePage().id, before = session.current;
  session[direction]();
  if (session.current === before) return;
  lock(true);
  try {
    for (const [key, source] of sources) {
      if (source.fields && before.fields[key] !== session.current.fields[key]) {
        await previewFields(source, source.fields, session.current.fields[key]);
      }
    }
    status(direction === 'undo' ? 'Edit undone.' : 'Edit redone.');
  } catch {
    status('History changed, but the form preview could not be refreshed.', true);
  } finally {
    lock(false);
    retainSelection(id);
    refresh({ reveal: true });
  }
}

async function confirmReplacement() {
  if (!session?.dirty) return true;
  const dialog = $('replace-dialog');
  dialog.returnValue = 'keep';
  dialog.showModal();
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
  return dialog.returnValue === 'discard';
}
async function importPDF(file, merge = false) {
  if (!file || busy || anyDialog()) return;
  lock(true);
  status(merge ? 'Reading PDF to merge…' : 'Opening PDF…');
  let loaded;
  try {
    loaded = await openPDF(file);
    if (!merge && !await confirmReplacement()) {
      status('Kept the current document and its edits.');
      return;
    }
    const id = `source-${++serial}`;
    if (merge) {
      sources.set(id, loaded);
      change({ type: 'merge', source: id, count: loaded.pdf.numPages }, `Appended ${loaded.pdf.numPages} page(s) from ${file.name}. Form fields will be flattened in the downloaded copy.`);
    } else {
      viewer.stop();
      for (const previous of sources.values()) void previous.destroy().catch(() => {});
      sources.clear();
      sources.set(id, loaded);
      baseId = id;
      selected = 0;
      zoom = 1;
      image = undefined;
      session = history(documentState(id, loaded.pdf.numPages));
      requestedState = undefined;
      setMode('view');
      refresh({ reset: true, reveal: true });
      status(`Opened ${file.name}.`);
    }
    loaded = undefined;
  } catch (error) {
    status(error.message || 'The PDF could not be opened.', true);
  } finally {
    if (loaded) void loaded.destroy().catch(() => {});
    lock(false);
  }
}

function fileInput(button, input, handler) {
  $(button).onclick = () => $(input).click();
  $(input).onchange = () => {
    const file = $(input).files[0];
    $(input).value = '';
    if (file) void handler(file);
  };
}
fileInput('open', 'file', importPDF);
$('start').onclick = () => $('file').click();
fileInput('merge', 'merge-file', file => importPDF(file, true));

let dragDepth = 0;
const isFileDrag = event => event.dataTransfer.types.includes('Files');
window.addEventListener('dragenter', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('dragging');
});
window.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy || anyDialog() ? 'none' : 'copy';
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
window.addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = event.dataTransfer.files;
  if (files.length > 1) { status('Drop one PDF at a time. Use Merge PDF to append another document.', true); return; }
  void importPDF(files[0]);
});
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    if (busy || anyDialog() || files.length > 1) {
      status('Could not open the launch files now. Use Open PDF when ready, one file at a time.', true);
      return;
    }
    try { await importPDF(await files[0].getFile()); }
    catch { status('The launched file could not be read. Try Open PDF.', true); }
  });
}

const pageAction = (type, message, delta) => {
  if (!ready()) return;
  change({ type, id: activePage().id, delta }, message);
};
$('rotate').onclick = () => pageAction('rotate', 'Page rotated clockwise.');
$('delete').onclick = () => pageAction('delete', 'Page deleted. Undo restores it. Form fields will be flattened in the downloaded copy.');
$('earlier').onclick = () => pageAction('move', 'Page moved earlier.', -1);
$('later').onclick = () => pageAction('move', 'Page moved later.', 1);
$('prev').onclick = () => go(selected - 1);
$('next').onclick = () => go(selected + 1);
$('page-number').onchange = event => go(event.target.valueAsNumber - 1);
$('page-number').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); } };
$('undo').onclick = () => historyStep('undo');
$('redo').onclick = () => historyStep('redo');
function adjustZoom(next, anchor) {
  if (!ready()) return;
  next = Math.max(.5, Math.min(3, next));
  if (next === zoom) return;
  zoom = next;
  refresh({ anchor });
}
$('zoom-in').onclick = () => adjustZoom(zoom * 1.25);
$('zoom-out').onclick = () => adjustZoom(zoom / 1.25);
$('zoom-fit').onclick = () => {
  if (!ready()) return;
  if (phoneLayout.matches) $('stage').scrollTo(0, 0);
  adjustZoom(1);
};
let stageWidth, resizeFrame;
new ResizeObserver(() => {
  const width = $('stage').clientWidth;
  if (width === stageWidth) return;
  stageWidth = width;
  cancelAnimationFrame(resizeFrame);
  if (session && width) resizeFrame = requestAnimationFrame(() => refresh());
}).observe($('stage'));
// At scale 1 the visual viewport is a slice of the layout viewport in CSS pixels.
// Keep using that slice even if an input blurs before the keyboard finishes closing.
const visualViewport = window.visualViewport;
const toolOptions = $('tool-options');
const pageBar = document.querySelector('.page-bar');
const phoneShell = document.body.style;
let visualFrame;
function syncVisualViewport() {
  visualFrame = undefined;
  const top = Math.max(0, visualViewport?.offsetTop ?? 0);
  const height = Math.min(visualViewport?.height ?? 0, window.innerHeight - top);
  const reduced = phoneLayout.matches && visualViewport?.scale === 1 && height > 0 && window.innerHeight - height > 1;
  document.body.classList.toggle('visual-viewport-reduced', reduced);
  if (reduced) {
    phoneShell.setProperty('--phone-visual-top', `${top}px`);
    phoneShell.setProperty('--phone-visual-height', `${height}px`);
    // Leave scroll room to pan the end of the PDF above the floating controls.
    const cover = toolOptions.getClientRects().length ? toolOptions : pageBar;
    const stage = $('stage').getBoundingClientRect();
    const room = cover.getClientRects().length ? stage.bottom - Math.max(stage.top, cover.getBoundingClientRect().top) : 0;
    phoneShell.setProperty('--phone-scroll-room', `${Math.max(0, room)}px`);
  } else {
    for (const key of ['--phone-visual-top', '--phone-visual-height', '--phone-scroll-room']) phoneShell.removeProperty(key);
  }
  const field = document.activeElement;
  if (!phoneLayout.matches || !toolOptions.contains(field) || !field.matches('#option-controls input') ||
      !field.getClientRects().length) return;
  const box = field.getBoundingClientRect(), sheet = toolOptions.getBoundingClientRect();
  const sheetTop = sheet.top + toolOptions.clientTop;
  // Only scroll the clipped options content, not an already visible input or the PDF.
  if (box.top < sheetTop || box.bottom > sheetTop + toolOptions.clientHeight) {
    field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
}
function queueVisualViewport() {
  if (visualFrame === undefined) visualFrame = requestAnimationFrame(syncVisualViewport);
}
visualViewport?.addEventListener('resize', queueVisualViewport);
visualViewport?.addEventListener('scroll', queueVisualViewport);
phoneLayout.addEventListener('change', queueVisualViewport);
toolOptions.addEventListener('focusin', queueVisualViewport);
if (visualViewport) new ResizeObserver(queueVisualViewport).observe(toolOptions);
queueVisualViewport();

let layoutWidth = window.innerWidth;
window.addEventListener('resize', () => {
  queueVisualViewport();
  // A toolbar or soft-keyboard height change alone should not exit immersive View.
  if (window.innerWidth === layoutWidth) return;
  layoutWidth = window.innerWidth;
  setImmersive(false);
});
screen.orientation?.addEventListener('change', () => {
  setImmersive(false);
  queueVisualViewport();
});
window.addEventListener('keydown', event => {
  if (phoneLayout.matches && ready() && event.key === 'Escape') {
    if (document.body.classList.contains('immersive')) { setImmersive(false); return; }
    if (mode !== 'view' && optionDisclosure.checked) {
      if ($('tool-options').contains(document.activeElement)) optionDisclosure.focus({ preventScroll: true });
      optionDisclosure.checked = false;
      return;
    }
  }
  if (!ready() || event.target.closest?.('input,select,textarea,[contenteditable]')) return;
  const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
  if (mod && ['z', 'y'].includes(key)) {
    event.preventDefault();
    void historyStep(key === 'y' || event.shiftKey ? 'redo' : 'undo');
  } else if (mod && key === 's') {
    event.preventDefault();
    void save();
  } else if (!mod && event.target === $('stage') && mode === 'view' && phoneLayout.matches && ['enter', ' '].includes(key)) {
    event.preventDefault();
    if (!event.repeat) setImmersive(!document.body.classList.contains('immersive'));
  } else if (!mod && event.target === $('stage') && ['arrowleft', 'arrowright', 'home', 'end'].includes(key)) {
    event.preventDefault();
    go({ arrowleft: selected - 1, arrowright: selected + 1, home: 0, end: session.current.pages.length - 1 }[key]);
  }
});

function setMode(next) {
  mode = next;
  setImmersive(false);
  viewer.cancelGestures();
  cancelStroke();
  $('paper').dataset.mode = mode;
  $('tool-options').hidden = mode === 'view';
  $('ink-width-option').hidden = mode !== 'ink';
  $('text-option').hidden = $('size-option').hidden = mode !== 'text';
  $('image-option').hidden = $('choose-image').hidden = mode !== 'image';
  $('keyboard-place').hidden = !['text', 'image'].includes(mode);
  $('color-option').hidden = !Object.hasOwn(colors, mode);
  if (!$('color-option').hidden) $('mark-color').value = colors[mode];
  $('tool-hint').textContent = ({
    text: 'Type a note, then click or tap the page to place it once.',
    ink: 'Drag on the page to draw freehand ink or a visual signature.',
    highlight: 'Drag over the area to mark it with translucent ink.',
    image: image ? `Ready to place: ${image.name}. Click or tap the top-left corner on the page.` : 'Choose an image or a scanned signature to place on this page.',
  })[mode] ?? '';
  for (const button of $('modes').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.mode === mode);
}
$('modes').onclick = event => {
  if (!ready() || !event.target.dataset.mode) return;
  setMode(event.target.dataset.mode);
  if (phoneLayout.matches) {
    optionDisclosure.checked = mode !== 'view';
    $('show-pages').checked = false;
  }
};
$('show-pages').onchange = () => { if ($('show-pages').checked) optionDisclosure.checked = false; };
optionDisclosure.onchange = () => { if (optionDisclosure.checked) $('show-pages').checked = false; };
$('mark-color').oninput = event => { if (Object.hasOwn(colors, mode)) colors[mode] = event.target.value; };
fileInput('choose-image', 'image-file', async file => {
  if (!ready()) return;
  const owner = session;
  const url = URL.createObjectURL(file);
  try {
    if (file.size > 20_000_000 || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error();
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2400 / Math.max(picture.naturalWidth, picture.naturalHeight));
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, file.type, .92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (session !== owner) return;
    image = { name: file.name, type: blob.type, bytes, ratio: canvas.height / canvas.width };
    const reader = new FileReader();
    const imported = image;
    image = undefined;
    reader.onload = () => {
      if (session !== owner) return;
      image = { ...imported, url: reader.result };
      if (mode === 'image') setMode(mode);
    };
    reader.onerror = () => status('Could not prepare the image for placement.', true);
    reader.readAsDataURL(blob);
  } catch {
    status('Choose a readable PNG or JPEG image under 20 MB.', true);
  } finally { URL.revokeObjectURL(url); }
});

function place(point) {
  if (!ready() || !point) return;
  let mark;
  if (mode === 'text') {
    const text = $('mark-text').value.trim();
    const size = $('mark-size').valueAsNumber;
    if (!text || !(size >= 8 && size <= 72)) { status('Enter text and a size from 8 to 72 pt before placing it.', true); return; }
    try { checkText(text); } catch (error) { status(error.message, true); return; }
    mark = { ...point, kind: mode, text, size, color: colors.text };
  } else if (mode === 'image') {
    const percent = $('image-width').valueAsNumber;
    if (!image || !(percent >= 10 && percent <= 95)) { status('Choose an image and enter a width from 10% to 95%.', true); return; }
    const width = point.viewWidth * percent / 100;
    mark = { ...point, kind: mode, image, width, height: width * image.ratio };
  }
  if (!mark) return;
  const added = change({ type: 'mark', id: activePage().id, mark }, `${mark.kind === 'text' ? 'Text' : 'Image'} added.`, false);
  if (added && mark.kind === 'text') $('mark-text').value = '';
  return added;
}
const overlay = $('overlay');
$('keyboard-place').onclick = event => {
  const rect = overlay.getBoundingClientRect();
  if (place(viewer.point(rect.left + rect.width / 2, rect.top + rect.height / 2)) && phoneLayout.matches) {
    event.currentTarget.focus({ preventScroll: true });
  }
};
overlay.addEventListener('pointerdown', event => {
  if (!ready() || !event.isPrimary || event.button !== 0 || !['ink', 'highlight'].includes(mode) ||
    (event.pointerType === 'touch' && !viewer.canStartTouchStroke())) return;
  const start = viewer.point(event.clientX, event.clientY);
  if (!start) return;
  event.preventDefault();
  // Touch pointers already have implicit capture on their original target.
  if (event.pointerType !== 'touch') overlay.setPointerCapture(event.pointerId);
  const inkWidth = phoneLayout.matches && $('ink-width').validity.valid ? $('ink-width').valueAsNumber : NaN;
  stroke = { pointer: event.pointerId, id: activePage().id, kind: mode, color: colors[mode],
    points: [[start.x, start.y]], size: mode === 'highlight' ? 14 : Number.isFinite(inkWidth) ? inkWidth : 2.5 };
});
function sample(event) {
  if (!stroke || stroke.pointer !== event.pointerId || stroke.points.length >= 6000) return;
  const point = viewer.point(event.clientX, event.clientY);
  if (!point) return;
  const [x, y] = stroke.points.at(-1);
  if (Math.hypot(x - point.x, y - point.y) >= .5) stroke.points.push([point.x, point.y]);
}
overlay.addEventListener('pointermove', event => {
  if (stroke?.pointer !== event.pointerId) return;
  const points = event.getCoalescedEvents?.();
  for (const item of points?.length ? points : [event]) sample(item);
  viewer.paint([...activePage().marks, stroke]);
});
overlay.addEventListener('pointerup', event => {
  if (stroke?.pointer !== event.pointerId) return;
  sample(event);
  const mark = stroke;
  stroke = undefined;
  if (ready() && mark.id === activePage().id && mark.points.length > 1) {
    change({ type: 'mark', id: mark.id, mark }, `${mark.kind === 'ink' ? 'Drawing' : 'Highlight'} added.`, false);
  } else viewer.paint();
});
for (const name of ['pointercancel', 'lostpointercapture']) overlay.addEventListener(name, event => {
  if (stroke?.pointer === event.pointerId) cancelStroke();
});

function download(bytes, suffix) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  const stem = sources.get(baseId).name.replace(/\.pdf$/i, '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 160) || 'document';
  link.download = `${stem}-${suffix}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return link.download;
}
async function save() {
  if (!ready()) return;
  lock(true);
  status('Preparing a new PDF…');
  try {
    const state = session.current;
    const bytes = await createPDF(sources, state, state.pages, baseId);
    const name = download(bytes, 'edited');
    requestedState = state;
    const next = session.dirty ? ' If you have the file, choose “I saved this copy”.' : '';
    status(`Download requested: ${name}. Check your browser’s downloads.${next}`);
  } catch (error) {
    status(`Could not save this PDF. Your edits are still open. ${error.message}`, true);
  } finally { lock(false); }
}
$('save').onclick = save;
$('confirm-save').onclick = () => {
  if (!ready() || !canConfirmSave()) return;
  session.checkpoint();
  controls();
  $('save').focus();
  status('You confirmed that you saved this version.');
};
$('extract').onclick = () => {
  if (!ready()) return;
  $('range').value = String(selected + 1);
  $('extract-error').textContent = '';
  $('extract-dialog').showModal();
};
$('extract-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const dialog = $('extract-dialog');
  lock(true);
  try {
    const state = session.current;
    const pages = selectPages(state.pages, $('range').value);
    const bytes = await createPDF(sources, state, pages, baseId, true);
    const name = download(bytes, 'extracted');
    dialog.close();
    status(`Download requested: ${name}. The open document is unchanged.`);
  } catch (error) { $('extract-error').textContent = error.message; }
  finally { lock(false); }
};

function fieldControl(field, value) {
  const label = document.createElement('label');
  label.textContent = field.name;
  let control, read;
  if (field.kind === 'checkbox') {
    label.className = 'field-row';
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = value;
    read = () => control.checked;
  } else if (field.kind === 'radio' || (field.kind === 'select' && !field.editable)) {
    control = document.createElement('select');
    control.multiple = Boolean(field.multi);
    if (!field.multi && !field.options.includes('')) control.add(new Option('No selection', ''));
    for (const item of field.options) {
      const option = new Option(item, item);
      option.selected = field.kind === 'radio' ? item === value : value.includes(item);
      control.add(option);
    }
    read = () => field.kind === 'radio' ? control.value : [...control.selectedOptions].map(o => o.value).filter(Boolean);
  } else {
    control = document.createElement(field.multiline ? 'textarea' : 'input');
    control.value = field.editable ? value[0] ?? '' : value;
    if (field.max !== undefined) control.maxLength = field.max;
    read = () => field.editable ? (control.value ? [control.value] : []) : control.value;
  }
  control.setAttribute('aria-label', field.name);
  label.append(control);
  $('fields').append(label);
  return () => ({ name: field.name, original: field.value, value: read() });
}
let readFields = [];
$('forms').onclick = async () => {
  if (!ready()) return;
  const sourceId = activePage().source;
  const source = sources.get(sourceId);
  lock(true);
  try {
    source.fields ??= await describeFields(source);
    formSource = sourceId;
    $('fields').replaceChildren();
    $('field-error').textContent = '';
    $('form-description').textContent = source.fields.length
      ? `Editable fields in ${source.name}. Select a page from another merged PDF to edit its fields.`
      : 'No supported editable form fields were found in this PDF.';
    const values = session.current.fields[sourceId] ?? {};
    readFields = source.fields.map(field => fieldControl(field, Object.hasOwn(values, field.name) ? values[field.name] : field.value));
    $('apply-fields').disabled = !readFields.length;
    $('form-dialog').showModal();
  } catch (error) { status(`Could not read this PDF’s form fields. ${error.message}`, true); }
  finally { lock(false); }
};
$('field-form').onsubmit = async event => {
  event.preventDefault();
  if (busy || !readFields.length) return;
  lock(true);
  try {
    const action = { type: 'fields', source: formSource, changes: readFields.map(read => read()) };
    const planned = edit(session.current, action);
    if (planned !== session.current) {
      const source = sources.get(formSource);
      await validateFields(source, planned.fields[formSource]);
      try { await previewFields(source, source.fields, planned.fields[formSource]); }
      catch { /* The generated PDF still has the validated values. */ }
      change(action, 'Form fields applied. Download a copy to keep them.');
    }
    $('form-dialog').close();
  } catch (error) { $('field-error').textContent = error.message; }
  finally { lock(false); }
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => { if (!busy) button.closest('dialog').close(); };
for (const id of ['extract-dialog', 'form-dialog']) $(id).addEventListener('cancel', event => { if (busy) event.preventDefault(); });

try {
  const theme = localStorage.getItem('paperplane-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* The system theme remains available. */ }
$('theme').onclick = () => {
  const root = document.documentElement;
  root.dataset.theme = getComputedStyle(root).colorScheme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('paperplane-theme', root.dataset.theme); } catch { /* Session theme only. */ }
};
let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('install').hidden = false;
});
$('install').onclick = async () => {
  try { await installPrompt?.prompt(); }
  catch { status('Use your browser’s menu to install this app if supported.', true); }
  finally { installPrompt = undefined; $('install').hidden = true; }
};
function updateOffline(message) {
  $('offline').textContent = message;
  if (!phoneLayout.matches) return;
  syncSheetDetails();
  if (phoneStatus.hidden) showPhoneStatus(message, false);
}
if ('serviceWorker' in navigator && window.isSecureContext) {
  const offlineLabel = () => updateOffline(navigator.onLine ? 'Offline ready' : 'Offline');
  navigator.serviceWorker.register('./sw.js').then(registration => {
    const check = worker => {
      if (!worker) return;
      const state = () => {
        if (worker.state === 'redundant' && !navigator.serviceWorker.controller) updateOffline('Offline setup failed');
      };
      worker.addEventListener('statechange', state);
      state();
    };
    check(registration.installing);
    registration.addEventListener('updatefound', () => check(registration.installing));
    return navigator.serviceWorker.ready;
  }).then(() => {
    offlineLabel();
    window.addEventListener('online', offlineLabel);
    window.addEventListener('offline', offlineLabel);
  }).catch(() => updateOffline('Offline setup failed'));
} else updateOffline('Offline requires HTTPS or localhost');
$('sheet-status').textContent = $('status').textContent;
syncPhoneLayout();
