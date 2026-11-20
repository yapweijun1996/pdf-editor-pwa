import { documentState, edit, history, insideBox, rotatePoint, selectPages, transformMark } from './model.js';
import { checkText, createPDF, describeFields, openPDF, previewFields, validateFields } from './pdf.js';
import * as vault from './save.js';
import { createViewer } from './viewer.js';
import { prepareStamps } from './stamps.js';

import { isShape, subtypes } from './shapes.js';

const $ = id => document.getElementById(id);
const sources = new Map();
const phoneLayout = matchMedia('(max-width: 768px)');
const sheet = $('tools-sheet');
const optionDisclosure = document.querySelector('#tool-options .mobile-disclosure input');
const phoneStatus = $('phone-status');
let fadeTimer, hideTimer;
const tabId = crypto.randomUUID();
const tabLock = id => `paperplane-workspace:${id}`;
let binding, draftId, draftState, pendingDraft, prepared, preparedURL;
const picker = () => typeof window.showOpenFilePicker === 'function';
// Reuse the same controls and listeners in the phone sheet and desktop groups.
const phoneControls = Object.entries({
  filename: document.querySelector('.masthead'),
  'file-options': $('sheet-actions'), install: $('sheet-actions'), theme: $('sheet-actions'), open: $('sheet-actions'), 'confirm-save': $('sheet-actions'),
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
let markId;
let mode = 'view', image, stroke, formSource, warned = false;
const colors = { text: '#15386a', ink: '#15386a', highlight: '#ffd12a' };
for (const kind of Object.keys(subtypes)) colors[kind] = '#15386a';
const checked = new Set();
const viewer = createViewer({
  checked, onCheck(id, value) { if (value) checked.add(id); else checked.delete(id); controls(); },
  onPosition(id) { if (!ready()) return; focusGroup(id); openPageTools(); $('move-position').focus(); },
  onDrop(id, target) {
    if (!ready()) return;
    focusGroup(id);
    if (checked.has(target)) return;
    const pages = session.current.pages, rest = pages.filter(p => !checked.has(p.id));
    const after = pages.findIndex(p => p.id === target) > pages.findIndex(p => p.id === id);
    groupAction('move', rest.findIndex(p => p.id === target) + 1 + Number(after));
  },
  stage: $('stage'), paper: $('paper'), canvas: $('canvas'), overlay: $('overlay'), thumbs: $('thumbs'),
  getSource: id => sources.get(id), onSelect: (index, reveal) => go(index, reveal), onError: message => status(message, true),
  canTap: () => ready() && (mode === 'image' || (mode === 'text' && Boolean($('mark-text').value.trim()))),
  canViewTap: () => ready() && phoneLayout.matches && mode === 'view',
  canPinch: () => ready(),
  onTap: (x, y) => place(viewer.point(x, y)),
  onViewTap: () => setImmersive(!document.body.classList.contains('immersive')),
  onPinch: (ratio, anchor) => adjustZoom(zoom * ratio, anchor),
  isPhone: () => phoneLayout.matches,
  canPan: () => ready() && !isShape(mode) && !['ink', 'highlight'].includes(mode),
  onMultitouch: cancelStroke, beginEdit, selectedMarkId: () => markId,
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
  syncSelection();
  const hasDocument = Boolean(session);
  const count = session?.current.pages.length ?? 0;
  $('welcome').hidden = hasDocument;
  $('workspace').hidden = !hasDocument;
  const filename = sources.get(baseId)?.name ?? 'No document open';
  const connected = Boolean(binding?.handle && picker());
  $('save-mode').textContent = connected ? 'Overwrites the original' : 'Saves a copy';
  $('save').querySelector('.desktop-download').textContent = connected ? 'Save original' : 'Download PDF';
  $('save').setAttribute('aria-label', connected ? 'Save original' : 'Download PDF');
  $('file-options').disabled = busy;
  $('save-copy').disabled = !hasDocument;
  $('restore-version').disabled = !hasDocument;
  $('prepared').hidden = !prepared || requestedState !== session?.current;
  $('file-notice').textContent = !picker() ? 'This browser cannot overwrite the original.' : connected ? 'Save writes to the connected original after backing it up.' : 'This workspace saves copies. Use Open PDF to connect an original.';
  $('filename').textContent = filename;
  $('filename').title = filename;
  $('shape-tools').hidden = $('sheet-document').hidden = !hasDocument;
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
  $('prev').disabled = busy || selected === 0;
  $('next').disabled = busy || selected >= count - 1;
  const group = hasDocument ? groupPages() : [];
  const first = hasDocument ? session.current.pages.indexOf(group[0]) : 0;
  $('earlier').disabled = busy || first <= 0;
  $('later').disabled = busy || first >= count - group.length;
  $('delete').disabled = busy || count === group.length;
  $('page-tools').disabled = busy || !hasDocument;
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
  markId = undefined;
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
async function importPDF(file, merge = false, handle) {
  await initialization;
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
      change({ type: 'merge', source: id, count: loaded.pdf.numPages, marks: loaded.marks }, `Appended ${loaded.pdf.numPages} page(s) from ${file.name}. Form fields will be flattened in the downloaded copy.`);
    } else {
      let doc = { id: crypto.randomUUID(), name: file.name }, notice = '';
      if (handle) {
        try { doc = await vault.connect(handle, file, loaded.bytes); }
        catch (error) { notice = ` Original saving unavailable: ${error.message} Use Save a copy.`; }
      }
      await forgetDraft();
      installWorkspace(loaded, doc);
      status(`Opened ${file.name}.${notice}`);
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
$('open').onclick = $('start').onclick = async () => {
  if (busy || anyDialog()) return;
  if (!picker()) return $('file').click();
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
    await importPDF(await handle.getFile(), false, handle);
  } catch (error) { if (error.name !== 'AbortError') status(`Picker unavailable. Use File options → Open copy-only. ${error.message}`, true); }
};
$('file-options').onclick = () => $('file-dialog').showModal();
$('copy-open').onclick = () => { $('file-dialog').close(); $('file').click(); };
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

function groupPages() {
  const group = session.current.pages.filter(p => checked.has(p.id));
  return group.length ? group : [activePage()];
}
function focusGroup(id) {
  if (!checked.has(id)) { checked.clear(); checked.add(id); }
  viewer.list(session.current.pages, selected); controls();
}
function groupAction(op, position) {
  const ids = groupPages().map(p => p.id);
  return change({ type:'group', op, ids, position }, `${ids.length} page(s): ${op}.`);
}
for (const op of ['rotate','delete']) $(op).onclick = () => ready() && groupAction(op);
for (const [key,delta] of [['earlier',-1],['later',1]]) $(key).onclick = () => ready() && groupAction('move', session.current.pages.indexOf(groupPages()[0])+1+delta);
function pageToolsState() {
  const pages = session.current.pages, group = groupPages();
  $('selection-summary').textContent = `Selected pages: ${group.map(p => pages.indexOf(p)+1).join(', ')}`;
  $('move-position').max = pages.length-group.length+1;
  $('move-position').value = pages.indexOf(group[0])+1;
  $('split-outputs').replaceChildren();
  for (const [index,ids] of (session.current.splitPlan ?? []).entries()) {
    const button = document.createElement('button');
    button.textContent = `Download part ${index+1}`;
    button.onclick = () => derived(ids, `part-${index+1}`);
    $('split-outputs').append(button);
  }
}
async function derived(ids, suffix) {
  if (busy) return;
  lock(true);
  try {
    const state = session.current, byId = new Map(state.pages.map(p => [p.id,p]));
    const bytes = await createPDF(sources,state,ids.map(id => byId.get(id)),baseId,true);
    $('pages-message').textContent = `Download requested: ${download(bytes,suffix)}. Original unchanged.`;
  } catch (e) { $('pages-message').textContent = e.message; }
  finally { lock(false); }
}
function openPageTools() {
  if (!ready()) return;
  pageToolsState(); $('pages-message').textContent = ''; $('pages-dialog').showModal();
}
$('page-tools').onclick = openPageTools;
for (const key of ['select-all-pages','clear-pages']) $(key).onclick = () => {
  if (busy) return;
  checked.clear(); if (key === 'select-all-pages') session.current.pages.forEach(p => checked.add(p.id));
  viewer.list(session.current.pages,selected); controls(); pageToolsState();
};
$('move-group').onclick = () => {
  if (busy) return;
  const position = $('move-position').valueAsNumber;
  if (!Number.isInteger(position) || !$('move-position').checkValidity()) { $('pages-message').textContent = `Enter a position from 1 to ${$('move-position').max}.`; return; }
  $('pages-dialog').close(); groupAction('move',position);
};
$('extract-group').onclick = () => derived(groupPages().map(p => p.id),'selection');
for (const side of ['before','after']) $(`blank-${side}`).onclick = () => {
  if (busy) return;
  $('pages-dialog').close(); const id = crypto.randomUUID();
  change({ type:'blank', newId:id, id:activePage().id, after:side==='after' }, 'Blank page inserted.');
  go(session.current.pages.findIndex(p => p.id === id));
};
$('plan-split').onclick = () => {
  if (busy) return;
  try { change({ type:'splitPlan', expression:$('split-ranges').value }, 'Split plan prepared.',false); pageToolsState(); $('pages-message').textContent = 'Plan prepared. Download each output separately.'; }
  catch (e) { $('pages-message').textContent = e.message; }
};

const stampsDialog = $('stamps-dialog'), stampsForm = $('stamps-form');
const stampField = name => $(`stamp-${name}`);
let stampRequest;
$('open-stamps').onclick = () => {
  if (busy || !$('pages-dialog').open) return;
  stampRequest?.abort();
  stampRequest = undefined;
  stampsForm.reset();
  $('stamp-fields').disabled = $('apply-stamps').disabled = false;
  stampField('message').textContent = '';
  const pages = session.current.pages;
  const positions = pages.flatMap((p, i) => checked.has(p.id) ? [i + 1] : []);
  stampField('range').value = positions.length ? positions.join(', ') : pages.length === 1 ? '1' : `1-${pages.length}`;
  viewer.cancelGestures();
  cancelStroke();
  $('pages-dialog').close();
  stampsDialog.showModal();
};
stampsDialog.addEventListener('close', () => {
  if (stampsDialog.open) return;
  stampRequest?.abort();
  stampRequest = undefined;
  if (!anyDialog()) $('page-tools').focus({ preventScroll: true });
});
stampsForm.onsubmit = async event => {
  event.preventDefault();
  if (!stampsDialog.open || busy || stampRequest) return;
  const state = session.current;
  const request = stampRequest = new AbortController();
  const options = Object.fromEntries(['range','header','footer','format','watermark','position'].map(key => [key, stampField(key).value]));
  for (const key of ['start','opacity','angle']) options[key] = stampField(key).valueAsNumber;
  $('stamp-fields').disabled = $('apply-stamps').disabled = true;
  stampField('message').textContent = '';
  try {
    const edits = await prepareStamps(state.pages, options,
      entry => sources.get(entry.source).pdf.getPage(entry.index + 1), request.signal);
    if (!request.signal.aborted && stampsDialog.open && session.current === state) {
      stampsDialog.close();
      change({ type: 'stampBatch', edits }, `Stamps applied to ${edits.length} page(s).`, false);
    }
  } catch (error) {
    if (!request.signal.aborted && stampsDialog.open) {
      stampField('message').textContent = error.message;
      $('stamp-fields').disabled = $('apply-stamps').disabled = false;
      stampField('range').focus();
    }
  } finally {
    if (stampRequest === request) stampRequest = undefined;
  }
};

const cropPreview = $('crop-preview'), cropFields = ['x','y','w','h'].map(k => $(`crop-${k}`));
let cropView, cropStart;
function cropValues() {
  const [x,y,w,h] = cropFields.map(f => f.valueAsNumber / cropView.userUnit);
  return [x,y,x+w,y+h];
}
function previewCrop() {
  const box = cropValues(), valid = insideBox(box,cropView.viewBox);
  const rect = cropPreview.querySelector('rect'); rect.style.display = valid ? '' : 'none';
  $('apply-crop').disabled = !valid;
  $('crop-message').textContent = valid ? '' : 'Enter a positive box inside the current visible page.';
  if (!valid) return;
  const [x,y] = cropView.convertToViewportPoint(box[0],box[1]);
  const [r,t] = cropView.convertToViewportPoint(box[2],box[3]);
  for (const [key,value] of Object.entries({ x:Math.min(x,r), y:Math.min(y,t), width:Math.abs(r-x), height:Math.abs(t-y) })) rect.setAttribute(key,value);
}
function fillCrop([x,y,r,t]) {
  [x,y,r-x,t-y].forEach((v,i) => { cropFields[i].value = v*cropView.userUnit; }); previewCrop();
}
cropFields.forEach(f => { f.oninput = previewCrop; });
$('crop-page').onclick = () => {
  if (busy || !viewer.view) { $('pages-message').textContent = 'Wait for the page preview.'; return; }
  cropView = viewer.view; cropStart = undefined;
  const {width,height} = cropView;
  cropPreview.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const image = cropPreview.querySelector('image'); image.setAttribute('href',$('canvas').toDataURL());
  image.setAttribute('width',width); image.setAttribute('height',height);
  cropPreview.querySelector('g').replaceChildren(...Array.from($('overlay').children,n => n.cloneNode(true)));
  fillCrop(cropView.viewBox); $('pages-dialog').close(); $('crop-dialog').showModal();
};
function cropPoint(e) {
  const p = new DOMPoint(e.clientX,e.clientY).matrixTransform(cropPreview.getScreenCTM().inverse());
  const point = cropView.convertToPdfPoint(p.x,p.y), b = cropView.viewBox;
  return point.map((n,i) => Math.min(b[i+2],Math.max(b[i],n)));
}
cropPreview.onpointerdown = e => { if (e.isPrimary && e.button === 0) { cropStart = cropPoint(e); cropPreview.setPointerCapture(e.pointerId); } };
cropPreview.onpointermove = e => {
  if (!cropStart || !e.isPrimary) return;
  const [x,y] = cropPoint(e), [a,b] = cropStart;
  fillCrop([Math.min(a,x),Math.min(b,y),Math.max(a,x),Math.max(b,y)]);
};
cropPreview.onpointerup = cropPreview.onpointercancel = () => { cropStart = undefined; };
$('apply-crop').onclick = () => {
  const box = cropValues(); if (!insideBox(box,cropView.viewBox)) return;
  $('crop-dialog').close(); change({ type:'crop', id:activePage().id, bounds:cropView.viewBox, box }, 'Crop applied. Content outside the box is hidden, not removed.');
};
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
  const scrollBox = field?.closest('#stamps-dialog[open]') ?? toolOptions;
  if (!phoneLayout.matches || !scrollBox.contains(field) || !field.matches('input,select,button') ||
      (scrollBox === toolOptions && !field.matches('#option-controls input')) || !field.getClientRects().length) return;
  const box = field.getBoundingClientRect(), sheet = scrollBox.getBoundingClientRect();
  const sheetTop = sheet.top + scrollBox.clientTop;
  // Only scroll clipped options, not an already visible input or the PDF.
  if (box.top < sheetTop || box.bottom > sheetTop + scrollBox.clientHeight) {
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
stampsDialog.addEventListener('focusin', queueVisualViewport);
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
  if (ready() && (mode === 'select' || isShape(mode)) && event.key === 'Escape') {
    setMode('view'); $('stage').focus({ preventScroll: true }); return;
  }
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
  if (!mod && mode === 'select' && markId && event.target === $('stage')) {
    if (key === 'delete' || key === 'backspace') { event.preventDefault(); removeMark(); return; }
    if (key.startsWith('arrow') && nudge(key.slice(5))) { event.preventDefault(); return; }
  }
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
  if (mode !== 'select') markId = undefined;
  setImmersive(false);
  viewer.cancelGestures();
  cancelStroke();
  $('paper').dataset.mode = mode;
  $('tool-options').hidden = mode === 'view';
  $('ink-width-option').hidden = mode !== 'ink';
  $('text-option').hidden = $('size-option').hidden = mode !== 'text';
  $('image-option').hidden = $('choose-image').hidden = mode !== 'image';
  $('paper').toggleAttribute('data-shape', isShape(mode));
  $('shape-color-option').hidden = $('shape-width-option').hidden = !isShape(mode);
  if (isShape(mode)) $('shape-color').value = colors[mode];
  $('keyboard-place').hidden = !isShape(mode) && !['text', 'image'].includes(mode);
  for (const button of $('shape-tools').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.shape === mode);
  $('color-option').hidden = !Object.hasOwn(colors, mode);
  if (!$('color-option').hidden) $('mark-color').value = colors[mode];
  $('tool-hint').textContent = ({
    text: 'Type a note, then click or tap the page to place it once.',
    ink: 'Drag on the page to draw freehand ink or a visual signature.',
    highlight: 'Drag over the area to mark it with translucent ink.',
    image: image ? `Ready to place: ${image.name}. Click or tap the top-left corner on the page.` : 'Choose an image or a scanned signature to place on this page.',
  })[mode] ?? (isShape(mode) ? `Drag a region for ${mode}, or place at page center.` : '');
  syncSelection();
  viewer.paint();
  for (const button of $('modes').querySelectorAll('button')) button.setAttribute('aria-pressed', button.dataset.mode === mode);
}
const selectedMark = () => activePage()?.marks.find(mark => mark.markId && mark.markId === markId);
function syncSelection() {
  $('selection-options').hidden = mode !== 'select';
  $('select-tool').setAttribute('aria-pressed', mode === 'select');
  if (mode !== 'select') return;
  const mark = selectedMark();
  if (!mark) markId = undefined;
  const list = $('mark-list');
  list.replaceChildren(new Option('Choose an item', ''), ...(activePage()?.marks ?? []).filter(m => m.kind !== 'stamp').map((m, i) => new Option(`${i + 1}. ${m.kind}`, m.markId)));
  list.value = markId ?? '';
  $('edit-color-label').hidden = $('edit-color-text-label').hidden = !mark?.color;
  $('edit-size-label').hidden = !mark?.size;
  if (mark?.color) $('edit-color-text').value = $('edit-color').value = mark.color;
  if (mark?.size) $('edit-size').value = mark.size;
  for (const button of $('selection-options').querySelectorAll('button')) button.disabled = !mark;
  $('tool-hint').textContent = 'Choose an item or tap it on the page. On the page, use arrows to move, Delete to remove, or Escape to deselect.';
}
function editSelected(delta) {
  if (ready() && selectedMark()) change({ type: 'editMark', id: activePage().id, markId, change: delta }, 'Item updated.', false);
}
function nudge(direction) {
  const vector = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] }[direction];
  const view = viewer.point(0, 0);
  if (!vector || !view) return false;
  const [dx, dy] = rotatePoint(...vector, view.angle);
  editSelected({ op: 'translate', dx, dy });
  return true;
}
for (const button of $('selection-options').querySelectorAll('[data-nudge]')) button.onclick = () => nudge(button.dataset.nudge);
function removeMark() {
  if (ready() && selectedMark()) change({ type: 'removeMark', id: activePage().id, markId }, 'Item removed.', false);
}
$('select-tool').onclick = () => {
  if (!ready()) return;
  setMode('select'); optionDisclosure.checked = true; $('mark-list').focus();
};
$('mark-list').onchange = event => {
  markId = event.target.value; syncSelection(); viewer.paint(); $('stage').focus({ preventScroll: true });
};
$('edit-size').onchange = event => editSelected({ op: 'style', size: event.target.valueAsNumber });
$('edit-color').onchange = event => editSelected({ op: 'style', color: event.target.value });
// Some browsers skip the native color picker in sequential keyboard navigation.
$('edit-color-text').onchange = event => {
  const field = event.target, color = field.value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) editSelected({ op: 'style', color });
  else status('Use a six-digit item color, such as #336699.', true);
  field.value = selectedMark()?.color ?? '';
};
$('shrink-mark').onclick = () => editSelected({ op: 'scale', factor: .8 });
$('grow-mark').onclick = () => editSelected({ op: 'scale', factor: 1.25 });
$('remove-mark').onclick = removeMark;
function beginEdit(event) {
  const page = activePage(), mark = page?.marks.find(m => m.markId === event.target.dataset.markId);
  if (!ready() || !mark) return;
  const start = viewer.point(event.clientX, event.clientY);
  if (!start) return;
  const resize = event.target.dataset.handle === 'resize';
  const units = start.viewWidth / $('overlay').getBoundingClientRect().width;
  markId = mark.markId;
  if (mode !== 'select') setMode('select');
  optionDisclosure.checked = false;
  syncSelection(); viewer.paint(); $('stage').focus({ preventScroll: true });
  const delta = e => {
    const x = e.clientX - event.clientX, y = e.clientY - event.clientY;
    if (Math.hypot(x, y) < 3) return null;
    if (resize) return { op: 'scale', factor: Math.max(.05, 1 + (x + y) / 120) };
    const [dx, dy] = rotatePoint(x * units, -y * units, start.angle);
    return { op: 'translate', dx, dy };
  };
  return { pointer: event.pointerId, cancel: () => viewer.paint(),
    move(e) {
      if (activePage() !== page) return;
      const d = delta(e);
      viewer.paint(page.marks.map(m => m === mark && d ? transformMark(m, d) : m));
    },
    finish(e) {
      const d = delta(e);
      if (activePage() === page && selectedMark() === mark && d) editSelected(d);
      viewer.paint();
    },
  };
}
$('shape-tools').onclick = event => {
  const kind = event.target.dataset.shape;
  if (!isShape(kind)) return;
  sheet.close();
  if (!ready()) return;
  setMode(kind); optionDisclosure.checked = true; $('shape-width').focus();
};
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
$('mark-color').oninput = event => {
  if (Object.hasOwn(colors, mode)) colors[mode] = event.target.value;
  if (isShape(mode)) $('shape-color').value = colors[mode];
};
$('shape-color').onchange = event => {
  if (!isShape(mode)) return;
  const color = event.target.value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) $('mark-color').value = colors[mode] = color;
  else status('Use a six-digit shape color, such as #336699.', true);
  event.target.value = colors[mode];
};
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
  if (isShape(mode)) {
    if (!$('shape-width').validity.valid || !$('shape-width').value) return;
    const [dx,dy] = rotatePoint(point.viewWidth*.14,-point.viewWidth*.05,point.angle);
    mark = { kind: mode, color: colors[mode], size: $('shape-width').valueAsNumber, angle: point.angle,
      points: [[point.x-dx/2,point.y-dy/2],[point.x+dx/2,point.y+dy/2]] };
  }
  if (!mark) return;
  mark.markId = crypto.randomUUID();
  const added = change({ type: 'mark', id: activePage().id, mark }, `${mark.kind[0].toUpperCase() + mark.kind.slice(1)} added.`, false);
  if (added && mark.kind === 'text') $('mark-text').value = '';
  return added;
}
const overlay = $('overlay');
window.addEventListener('blur', cancelStroke);
$('keyboard-place').onclick = event => {
  const rect = overlay.getBoundingClientRect();
  if (place(viewer.point(rect.left + rect.width / 2, rect.top + rect.height / 2)) && phoneLayout.matches) {
    event.currentTarget.focus({ preventScroll: true });
  }
};
overlay.addEventListener('pointerdown', event => {
  if (!ready() || !event.isPrimary || event.button !== 0 || (!isShape(mode) && !['ink', 'highlight'].includes(mode)) ||
    (isShape(mode) && (!$('shape-width').value || !$('shape-width').validity.valid)) ||
    (event.pointerType === 'touch' && !viewer.canStartTouchStroke())) return;
  const start = viewer.point(event.clientX, event.clientY);
  if (!start) return;
  event.preventDefault();
  // Touch pointers already have implicit capture on their original target.
  if (event.pointerType !== 'touch') overlay.setPointerCapture(event.pointerId);
  const inkWidth = phoneLayout.matches && $('ink-width').validity.valid ? $('ink-width').valueAsNumber : NaN;
  stroke = { pointer: event.pointerId, id: activePage().id, kind: mode, color: colors[mode],
    ...(isShape(mode) ? { angle: start.angle } : {}),
    points: [[start.x, start.y]], size: isShape(mode) ? $('shape-width').valueAsNumber : mode === 'highlight' ? 14 : Number.isFinite(inkWidth) ? inkWidth : 2.5 };
});
function sample(event) {
  if (!stroke || stroke.pointer !== event.pointerId || stroke.points.length >= 6000) return;
  const point = viewer.point(event.clientX, event.clientY);
  if (!point) return;
  if (isShape(stroke.kind)) {
    const [x,y] = stroke.points[0];
    stroke.points.length = 1;
    if (Math.hypot(x-point.x,y-point.y) >= 2) stroke.points.push([point.x,point.y]);
    return;
  }
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
    const { pointer, id, ...geometry } = mark;
    change({ type: 'mark', id, mark: { ...geometry, markId: crypto.randomUUID() } }, `${mark.kind === 'ink' ? 'Drawing' : mark.kind[0].toUpperCase() + mark.kind.slice(1)} added.`, false);
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
function installWorkspace(loaded, doc, recovered = false) {
  viewer.stop();
  for (const previous of sources.values()) void previous.destroy().catch(() => {});
  sources.clear();
  baseId = `source-${++serial}`;
  sources.set(baseId, loaded);
  binding = doc;
  draftId = `${tabId}:${crypto.randomUUID()}`;
  draftState = requestedState = prepared = undefined;
  if (preparedURL) URL.revokeObjectURL(preparedURL);
  preparedURL = undefined;
  selected = 0; zoom = 1; image = undefined;
  checked.clear(); $('split-ranges').value = '';
  const initial = documentState(baseId, loaded.pdf.numPages, loaded.marks);
  if (loaded.splitIndices) initial.splitPlan = loaded.splitIndices.map(g => g.map(i => initial.pages[i].id));
  const timeline = history(initial);
  session = Object.create(timeline, {
    dirty: { get: () => recovered || timeline.dirty },
    checkpoint: { value: () => { recovered = false; timeline.checkpoint(); } },
  });
  setMode('view');
  refresh({ reset: true, reveal: true });
}
const materialize = () => createPDF(new Map(sources), session.current, session.current.pages, baseId);
async function forgetDraft() {
  await pendingDraft;
  if (draftState) await vault.clearDraft(draftId);
  draftState = undefined;
}
async function autosave() {
  if (busy || !session || pendingDraft) return;
  const state = session.current;
  if (session.dirty && draftState === state || !session.dirty && !draftState) return;
  const persist = async () => {
    if (session.dirty) {
      const bytes = await materialize();
      await vault.saveDraft(draftId, binding, bytes);
      draftState = state;
    } else { await vault.clearDraft(draftId); draftState = undefined; }
  };
  pendingDraft = persist().catch(error => status(`Local autosave unavailable: ${error.message}`, true));
  try { await pendingDraft; } finally { pendingDraft = undefined; }
}
setInterval(autosave, 10000);
function choice(title, description, items) {
  const dialog = $('save-choice');
  $('choice-title').textContent = title;
  $('choice-description').textContent = description;
  $('choices').replaceChildren(...items.map(([value, label]) => {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => dialog.close(value); return button;
  }));
  dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}
function prepareCopy(bytes, state) {
  const name = download(bytes, 'edited');
  requestedState = state;
  if (preparedURL) URL.revokeObjectURL(preparedURL);
  prepared = new File([bytes], name, { type: 'application/pdf' });
  $('view-copy').href = preparedURL = URL.createObjectURL(prepared);
  $('share-copy').hidden = !navigator.canShare?.({ files: [prepared] });
  status(`Download requested: ${name}. File options offers Open prepared PDF or sharing. Check your copy before choosing “I saved this copy”.`);
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone || !$('share-copy').hidden) $('file-dialog').showModal();
}
$('share-copy').onclick = async () => {
  try { await navigator.share({ files: [prepared] }); }
  catch (error) { $('file-notice').textContent = `Copy not shared: ${error.message}`; }
};
const conflict = () => choice('Original changed on disk', 'Reload replaces local edits and keeps a recovery snapshot. Overwrite backs up the current disk bytes first.', [['cancel','Cancel'], ['reload','Reload from disk'], ['overwrite','Overwrite anyway'], ['copy','Save a copy']]);
async function archiveWorking() {
  await pendingDraft;
  if (session.dirty) await vault.saveDraft(crypto.randomUUID(), binding, await materialize());
}
async function transact(bytes, count, restoring) {
  const result = await vault.replaceOriginal(binding, bytes, count, conflict);
  if (result.action === 'copy') { prepareCopy(restoring ? await materialize() : bytes, session.current); return; }
  if (result.action === 'reload') {
    await archiveWorking();
    const loaded = await openPDF(result.current.file);
    await forgetDraft();
    installWorkspace(loaded, { ...binding, baseline: result.current.stamp });
    status('Reloaded from disk. Previous edits are recoverable on next launch.'); return;
  }
  if (result.action !== 'saved') return;
  binding = { ...binding, baseline: result.baseline };
  await forgetDraft();
  if (restoring) installWorkspace(await openPDF(new File([bytes], binding.name)), binding);
  else session.checkpoint();
  status(restoring ? 'Previous version verified on disk.' : 'Saved and verified the original.');
}
async function save(copyOnly = false) {
  if (!ready()) return;
  lock(true);
  try {
    const state = session.current;
    if (binding.handle && picker() && !copyOnly) {
      await vault.permission(binding.handle);
      await transact(await materialize(), state.pages.length, false);
    } else prepareCopy(await materialize(), state);
  } catch (error) { status(`Save did not finish: ${error.message} File options → Save a copy is available.`, true); }
  finally { lock(false); }
}
$('save').onclick = () => save();
$('save-copy').onclick = () => { $('file-dialog').close(); void save(true); };
$('restore-version').onclick = async () => {
  $('file-dialog').close();
  if (!ready()) return;
  lock(true);
  try {
    const versions = await vault.backups(binding);
    const id = await choice('Restore previous version', versions.length ? 'Choose original bytes to restore. Unsaved edits will be kept as a recovery snapshot.' : 'No original-file backups for this document.', [['cancel','Cancel'], ...versions.map(v => [v.id, `${v.name} · ${new Date(v.time).toLocaleString()} · ${v.hash}`])]);
    const version = versions.find(v => v.id === id);
    if (!version) return;
    const action = await choice('Restore destination', 'Workspace only does not modify the original.', [['cancel','Cancel'], ['workspace','Workspace only'], ...(binding.handle && picker() ? [['disk','Restore original']] : [])]);
    if (!['disk','workspace'].includes(action)) return;
    if (action === 'disk') await vault.permission(binding.handle);
    const bytes = await vault.readVersion(version);
    await archiveWorking();
    if (action === 'disk') await transact(bytes, undefined, true);
    else {
      const loaded = await openPDF(new File([bytes], binding.name));
      await forgetDraft(); installWorkspace(loaded, { id: binding.id, name: binding.name }, true);
      status('Restored workspace only. Save a copy to keep it.');
    }
  } catch (error) { status(`Restore did not finish: ${error.message}`, true); }
  finally { lock(false); }
};
$('confirm-save').onclick = async () => {
  if (!ready() || !canConfirmSave()) return;
  lock(true);
  try { await forgetDraft(); session.checkpoint(); }
  catch (error) { status(`Could not clear the recovery record: ${error.message}`, true); return; }
  finally { lock(false); }
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
async function recover() {
    const active = new Set((await navigator.locks.query()).held.map(lock => lock.name));
    for (const draft of (await vault.drafts()).sort((a,b) => b.time - a.time)) {
      if (active.has(tabLock(draft.id.split(':')[0]))) continue;
      const answer = await choice('Recover unsaved work?', `${draft.doc.name} · ${new Date(draft.time).toLocaleString()}. Restores the last autosaved PDF, without undo history.`, [['later','Not now'], ['recover','Recover workspace'], ['discard','Discard recovery']]);
      if (answer === 'discard') await vault.clearDraft(draft.id);
      if (answer !== 'recover') continue;
      const bytes = await vault.readVersion(draft);
      let doc = draft.doc;
      if (doc.handle && picker()) {
        try { await doc.handle.queryPermission({ mode: 'readwrite' }); }
        catch { doc = { id: doc.id, name: doc.name }; }
      }
      else doc = { id: doc.id, name: doc.name };
      installWorkspace(await openPDF(new File([bytes], doc.name)), doc, true);
      await vault.saveDraft(draftId, doc, bytes);
      draftState = session.current;
      await vault.clearDraft(draft.id);
      status('Recovered unsaved edits. The original has not been changed.'); break;
    }
}
const initialization = (async () => {
  lock(true);
  try {
    await new Promise((resolve, reject) => {
      navigator.locks.request(tabLock(tabId), () => {
        resolve();
        return new Promise(() => {}); // Released automatically when this realm exits.
      }).catch(reject);
    });
    await navigator.locks.request('paperplane-recovery', recover);
  } catch (error) { status(`Recovery unavailable: ${error.message}`, true); }
  finally { lock(false); }
})();
