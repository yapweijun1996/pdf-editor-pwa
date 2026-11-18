import { annotationMode } from './pdf.js';

const svg = (tag, attributes) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};

export function createViewer({ stage, paper, canvas, overlay, thumbs, getSource, onSelect, onError }) {
  let generation = 0, task, viewport, active, observer, thumbnailKey;
  const jobs = new Map();
  const stop = () => {
    generation++;
    task?.cancel();
    viewport = undefined;
    paper.hidden = true;
  };

  function paint(marks = active?.marks ?? []) {
    if (!viewport) return;
    overlay.replaceChildren();
    for (const mark of marks) {
      if (mark.points) {
        overlay.append(svg('polyline', {
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
        overlay.append(node);
      } else {
        overlay.append(svg('image', { transform, width: mark.width * scale, height: mark.height * scale, href: mark.image.url }));
      }
    }
  }

  async function show(entry, zoom, resetScroll) {
    stop();
    const id = generation;
    active = entry;
    try {
      const page = await getSource(entry.source).pdf.getPage(entry.index + 1);
      if (id !== generation) return;
      const rotation = (page.rotate + entry.rotation) % 360;
      const original = page.getViewport({ scale: 1, rotation });
      const style = getComputedStyle(stage);
      const available = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
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
      paint();
      paper.hidden = false;
      if (resetScroll) stage.scrollTo(0, 0);
    } catch (error) {
      if (id === generation && error.name !== 'RenderingCancelledException') onError('This page could not be rendered.');
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
    stop, show, paint, list,
    update(entry) { active = entry; paint(); },
    point(clientX, clientY) {
      if (!viewport) return null;
      const rect = overlay.getBoundingClientRect();
      const x = Math.min(overlay.clientWidth, Math.max(0, clientX - rect.left)) / rect.width * viewport.width;
      const y = Math.min(overlay.clientHeight, Math.max(0, clientY - rect.top)) / rect.height * viewport.height;
      const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
      return { x: pdfX, y: pdfY, angle: viewport.rotation, viewWidth: viewport.width / (viewport.scale * viewport.userUnit) };
    },
  };
}
