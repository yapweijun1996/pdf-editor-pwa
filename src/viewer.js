import { geometry, isShape } from './shapes.js';
import { annotationMode } from './pdf.js';

const svg = (tag, attributes) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};

const TAP_SLOP = 10; // CSS pixels, independent of PDF zoom and device pixel ratio.
const TAP_TIMEOUT = 500;

function pageGestures({ stage, overlay, canTap, canViewTap, canPinch, canPan, isPhone,
  zoomAnchor, onTap, onViewTap, onPinch, onMultitouch, beginEdit }) {
  const touches = new Map();
  let tap, drag, pinch, editing;
  const cancel = () => {
    editing?.cancel();
    tap = drag = pinch = editing = undefined;
  };
  const separation = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const scrollOrigin = () => ({ left: stage.scrollLeft, top: stage.scrollTop });
  const pan = (origin, dx, dy) => stage.scrollTo(origin.left - dx, origin.top - dy);
  const on = (type, handler) => window.addEventListener(type, handler, true);
  function pair() {
    const [{ event: a }, { event: b }] = touches.values();
    return { distance: separation(a, b), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }
  function movePinch() {
    const current = pair();
    const dx = current.x - pinch.x, dy = current.y - pinch.y;
    if (pinch.moving || Math.hypot(dx, dy) > TAP_SLOP) {
      pinch.moving = true;
      pan(pinch.scroll, dx, dy);
    }
    return current;
  }

  on('pointerdown', event => {
    if (event.pointerType === 'touch') {
      const inStage = stage.contains(event.target);
      touches.set(event.pointerId, { event, inStage });
      if (touches.size > 1) {
        cancel();
        onMultitouch();
        if (touches.size === 2 && [...touches.values()].every(touch => touch.inStage) && canPinch()) {
          const start = pair();
          if (start.distance > 0) pinch = { ...start, scroll: scrollOrigin(), anchor: zoomAnchor(start.x, start.y) };
        }
        return;
      }
      // On phones, keep pointer delivery in the stage even if a second finger joins a drag.
      if (isPhone() && inStage && canPan()) drag = { start: event, scroll: scrollOrigin() };
    }
    tap = undefined;
    if (!event.isPrimary || event.button !== 0 || touches.size > Number(event.pointerType === 'touch')) return;
    if (event.target.closest?.('[data-mark-id]')) {
      editing = beginEdit(event);
      if (editing) {
        drag = undefined;
        event.preventDefault();
        event.stopPropagation();
        if (event.isTrusted) overlay.setPointerCapture(event.pointerId);
        return;
      }
    }
    const viewTap = canViewTap();
    const target = viewTap ? stage : overlay;
    if ((!viewTap && !canTap()) || !target.contains(event.target)) return;
    const { left, top } = target.getBoundingClientRect();
    tap = { start: event, left, top, target };
  });

  on('pointermove', event => {
    const touch = touches.get(event.pointerId);
    if (touch) {
      touch.event = event;
      if (pinch && canPinch()) movePinch();
    }
    if (editing?.pointer === event.pointerId) { editing.move(event); return; }
    if (drag?.start.pointerId === event.pointerId && canPan()) {
      const { start, scroll } = drag;
      if (drag.moving || separation(start, event) > TAP_SLOP) {
        tap = undefined;
        drag.moving = true;
        pan(scroll, event.clientX - start.clientX, event.clientY - start.clientY);
      }
    }
    if (tap?.start.pointerId !== event.pointerId) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    if (separation(tap.start, event) > TAP_SLOP || samples.some(item => separation(tap.start, item) > TAP_SLOP)) {
      tap = undefined;
    }
  });

  on('pointerup', event => {
    if (touches.has(event.pointerId) && pinch) {
      const start = pinch;
      const current = canPinch() ? movePinch() : null;
      cancel();
      touches.delete(event.pointerId);
      // Render once on release; anchor the original midpoint under the final midpoint.
      if (current && Math.abs(current.distance - start.distance) > TAP_SLOP) {
        const rect = stage.getBoundingClientRect();
        onPinch(current.distance / start.distance, { ...start.anchor, left: current.x - rect.left, top: current.y - rect.top });
      }
      return;
    }
    touches.delete(event.pointerId);
    if (editing?.pointer === event.pointerId) {
      const completed = editing;
      editing = undefined;
      completed.finish(event);
      return;
    }
    if (drag?.start.pointerId === event.pointerId) drag = undefined;
    if (tap?.start.pointerId !== event.pointerId) return;
    const { start, left, top, target } = tap;
    tap = undefined;
    const viewTap = target === stage;
    const rect = target.getBoundingClientRect();
    if ((viewTap ? canViewTap() : canTap()) && !touches.size && event.button === 0 &&
      event.timeStamp - start.timeStamp <= TAP_TIMEOUT && separation(start, event) <= TAP_SLOP &&
      rect.left === left && rect.top === top && target.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      // The compatibility click is not a second gesture.
      if (viewTap) onViewTap();
      else onTap(event.clientX, event.clientY);
    }
  });

  on('pointercancel', event => {
    if (touches.delete(event.pointerId) || editing?.pointer === event.pointerId) cancel();
    if (tap?.start.pointerId === event.pointerId) tap = undefined;
  });
  on('lostpointercapture', event => {
    if (event.target === overlay && (touches.delete(event.pointerId) || editing?.pointer === event.pointerId)) cancel();
    if (tap?.start.pointerId === event.pointerId) tap = undefined;
  });
  on('scroll', event => { if (event.target === stage || event.target === document) tap = undefined; });
  on('blur', event => { if (event.target === window) { cancel(); touches.clear(); } });
  for (const type of ['touchstart', 'touchmove']) stage.addEventListener(type, event => {
    if (pinch && event.touches.length >= 2 && event.cancelable) event.preventDefault();
  }, { passive: false });
  return { cancel, canStartTouchStroke: () => touches.size === 1 };
}

export function createViewer({ stage, paper, canvas, overlay, thumbs, getSource, onSelect, onError,
  canTap, canViewTap, canPinch, canPan, isPhone, onTap, onViewTap, onPinch, onMultitouch, beginEdit, selectedMarkId }) {
  let generation = 0, task, viewport, active, observer, thumbnailKey;
  const jobs = new Map();
  function zoomAnchor(clientX, clientY) {
    const pageRect = paper.getBoundingClientRect();
    return { x: (clientX - pageRect.left) / pageRect.width, y: (clientY - pageRect.top) / pageRect.height };
  }
  const { cancel: cancelGestures, canStartTouchStroke } = pageGestures({ stage, overlay,
    canTap: () => Boolean(viewport) && canTap(), canViewTap: () => Boolean(viewport) && canViewTap(),
    canPinch: () => Boolean(viewport) && canPinch(), canPan: () => Boolean(viewport) && canPan(),
    isPhone, zoomAnchor, onTap, onViewTap, onPinch, onMultitouch, beginEdit });
  const stop = (keepPaper = false) => {
    cancelGestures();
    generation++;
    task?.cancel();
    viewport = undefined;
    if (!keepPaper) paper.hidden = true;
  };

  function paint(marks = active?.marks ?? []) {
    if (!viewport) return;
    overlay.replaceChildren();
    let selectedNode;
    for (const mark of marks) {
      const append = node => {
        if (mark.markId) node.dataset.markId = mark.markId;
        if (mark.markId && mark.markId === selectedMarkId()) selectedNode = node;
        overlay.append(node);
      };
      if (isShape(mark.kind)) {
        const d = geometry(mark).path.map(([op,...args]) => {
          const coords = [];
          for (let i=0;i<args.length;i+=2) coords.push(...viewport.convertToViewportPoint(args[i],args[i+1]));
          return `${op}${coords.join(' ')}`;
        }).join(' ');
        append(svg('path', { d, fill:'none', stroke:mark.color, 'stroke-width':mark.size*viewport.scale*viewport.userUnit, 'stroke-linejoin':'round', 'stroke-linecap':'round' }));
        continue;
      }
      if (mark.points) {
        append(svg('polyline', {
          points: mark.points.map(point => viewport.convertToViewportPoint(...point).join(',')).join(' '),
          fill: 'none', stroke: mark.color, 'stroke-width': mark.size * viewport.scale * viewport.userUnit,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: mark.kind === 'highlight' ? .38 : 1,
        }));
        continue;
      }
      const [x, y] = viewport.convertToViewportPoint(mark.x, mark.y);
      const scale = viewport.scale * viewport.userUnit;
      const transform = `translate(${x} ${y}) rotate(${viewport.rotation - mark.angle})`;
      if (mark.kind === 'text') {
        const node = svg('text', { transform, fill: mark.color, 'font-family': 'Helvetica, Arial, sans-serif', 'font-size': mark.size * scale, 'xml:space': 'preserve' });
        node.textContent = mark.text;
        append(node);
      } else {
        append(svg('image', { transform, width: mark.width * scale, height: mark.height * scale, href: mark.image.url }));
      }
    }
    if (selectedNode) {
      const bounds = selectedNode.getBoundingClientRect(), page = overlay.getBoundingClientRect();
      const left = bounds.left - page.left, top = bounds.top - page.top;
      overlay.append(svg('rect', { x: left, y: top, width: bounds.width, height: bounds.height, class: 'selection-frame' }));
      // The viewport is laid out at CSS resolution; raster backing scale is irrelevant.
      const y = Math.max(0, Math.min(page.height - 46, top + bounds.height));
      const x = Math.max(46, Math.min(page.width - 46, left + bounds.width));
      for (const [operation, position] of [['move', Math.min(x - 46, Math.max(0, left - 46))], ['resize', x]]) {
        overlay.append(svg('rect', { x: position, y, width: 46, height: 46, rx: 7, 'data-handle': operation, 'data-mark-id': selectedNode.dataset.markId }));
        overlay.append(svg('path', { d: operation === 'move' ? 'M9 23h28m-14-14v28' : 'M13 33l20-20m-12 0h12v12', transform: `translate(${position} ${y})`, class: 'handle-symbol' }));
      }
    }
  }

  async function show(entry, zoom, resetScroll, anchor) {
    stop(Boolean(anchor));
    const id = generation;
    active = entry;
    try {
      const page = await getSource(entry.source).pdf.getPage(entry.index + 1);
      if (id !== generation) return;
      const rotation = (page.rotate + entry.rotation) % 360;
      const original = page.getViewport({ scale: 1, rotation });
      const style = getComputedStyle(stage);
      const available = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (isPhone() ? 0 : 2);
      const scale = Math.max(1, Math.min(available, 1100)) / original.width * zoom;
      const view = page.getViewport({ scale, rotation });
      const ratio = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(view.width, view.height),
        Math.sqrt(10_000_000 / (view.width * view.height)));
      const width = Math.max(1, Math.ceil(view.width * ratio));
      const height = Math.max(1, Math.ceil(view.height * ratio));
      const buffer = document.createElement('canvas');
      buffer.width = width;
      buffer.height = height;
      task = page.render({ canvas: buffer, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode });
      await task.promise;
      if (id !== generation) return;
      viewport = view;
      paper.style.width = `${view.width}px`;
      paper.style.height = `${view.height}px`;
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(buffer, 0, 0);
      overlay.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
      paper.hidden = false;
      paint();
      if (resetScroll) stage.scrollTo(0, 0);
      if (anchor) {
        const pageRect = paper.getBoundingClientRect(), stageRect = stage.getBoundingClientRect();
        stage.scrollBy(pageRect.left + anchor.x * pageRect.width - stageRect.left - anchor.left,
          pageRect.top + anchor.y * pageRect.height - stageRect.top - anchor.top);
      }
    } catch (error) {
      if (id === generation && error.name !== 'RenderingCancelledException') {
        paper.hidden = true;
        onError('This page could not be rendered.');
      }
    }
  }

  function cancelThumb(button) {
    const job = jobs.get(button);
    if (job) {
      jobs.delete(button);
      job.task?.cancel();
    }
    button.querySelector('canvas')?.remove();
  }

  async function preview(button, entry) {
    if (jobs.has(button)) return;
    const job = {};
    jobs.set(button, job);
    try {
      const page = await getSource(entry.source).pdf.getPage(entry.index + 1);
      if (jobs.get(button) !== job) return;
      const rotation = (page.rotate + entry.rotation) % 360;
      const original = page.getViewport({ scale: 1, rotation });
      const view = page.getViewport({ scale: Math.min(105 / original.width, 100 / original.height), rotation });
      const tile = document.createElement('canvas');
      tile.width = Math.ceil(view.width);
      tile.height = Math.ceil(view.height);
      job.task = page.render({ canvas: tile, viewport: view, annotationMode });
      await job.task.promise;
      if (jobs.get(button) === job) button.firstChild.append(tile);
    } catch {
      // A failed or canceled preview keeps its page number and remains navigable.
    }
  }

  function list(pages, selected, reveal = false) {
    const key = pages.map(p => `${p.id}/${p.rotation}`).join(',');
    if (thumbnailKey !== key) {
      thumbnailKey = key;
      observer?.disconnect();
      for (const button of jobs.keys()) cancelThumb(button);
      observer = new IntersectionObserver(entries => {
        for (const item of entries) {
          if (!thumbs.contains(item.target)) continue;
          if (item.isIntersecting) void preview(item.target, pages[Number(item.target.dataset.index)]);
          else cancelThumb(item.target);
        }
      }, { root: thumbs });
      const buttons = pages.map((page, index) => {
        const button = document.createElement('button');
        const surface = document.createElement('span');
        surface.className = 'thumb-surface';
        surface.setAttribute('aria-hidden', 'true');
        button.dataset.index = index;
        button.setAttribute('aria-label', `Go to page ${index + 1}`);
        button.append(surface, `${index + 1}${page.marks.length ? ' •' : ''}`);
        button.onclick = () => onSelect(index, false);
        return button;
      });
      thumbs.replaceChildren(...buttons);
      for (const button of buttons) observer.observe(button);
    }
    Array.from(thumbs.children).forEach((button, index) => {
      button.lastChild.textContent = `${index + 1}${pages[index].marks.length ? ' •' : ''}`;
      if (selected === index) {
        button.setAttribute('aria-current', 'page');
        if (reveal) {
          const target = button.getBoundingClientRect(), area = thumbs.getBoundingClientRect();
          if (target.top < area.top || target.bottom > area.bottom) thumbs.scrollTop += target.top - area.top;
          if (target.left < area.left || target.right > area.right) thumbs.scrollLeft += target.left - area.left;
        }
      } else button.removeAttribute('aria-current');
    });
  }

  return {
    stop, show, paint, list, cancelGestures, canStartTouchStroke,
    update(entry) { active = entry; paint(); },
    point(clientX, clientY) {
      if (!viewport) return null;
      const matrix = overlay.getScreenCTM();
      if (!matrix) return null;
      const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
      const x = Math.min(viewport.width, Math.max(0, point.x));
      const y = Math.min(viewport.height, Math.max(0, point.y));
      const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
      return { x: pdfX, y: pdfY, angle: viewport.rotation, viewWidth: viewport.width / (viewport.scale * viewport.userUnit) };
    },
  };
}
