// Installed before the application reads visualViewport. The layout viewport never changes.
export function installVisualKeyboard({ height, width }) {
  // The init script runs before viewport metadata is parsed; use the configured dimensions.
  const viewport = Object.assign(new EventTarget(), {
    height, width, offsetTop: 0, offsetLeft: 0,
    pageTop: scrollY, pageLeft: scrollX, scale: 1,
  });
  Object.defineProperty(window, 'visualViewport', { value: viewport });
  window.setVisualKeyboard = ({ height, top, event }) => {
    Object.assign(viewport, { height, offsetTop: top, pageTop: scrollY + top });
    const bottom = top + height;
    let mask = document.getElementById('emulated-keyboard');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'emulated-keyboard';
      mask.setAttribute('aria-hidden', 'true');
      mask.textContent = 'Emulated keyboard';
      Object.assign(mask.style, {
        position: 'fixed', zIndex: '2147483647', left: '0', right: '0', bottom: '0',
        display: 'grid', placeItems: 'center', background: '#27354b', color: 'white',
        borderTop: '2px solid #8ca9d4', pointerEvents: 'auto',
      });
      document.body.append(mask);
    }
    mask.style.top = `${bottom}px`;
    mask.style.display = bottom < innerHeight ? 'grid' : 'none';
    viewport.dispatchEvent(new Event(event));
  };
}

export function keyboardMetrics() {
  const get = selector => document.querySelector(selector);
  const rect = selector => get(selector).getBoundingClientRect().toJSON();
  const stage = get('#stage');
  const { height, offsetTop: top, width, scale } = visualViewport;
  const bottom = top + height;
  const mask = bottom < innerHeight && document.elementFromPoint(innerWidth / 2, bottom + 1)?.id;
  return {
    layout: [innerWidth, innerHeight, document.documentElement.clientWidth, document.documentElement.clientHeight],
    visual: { height, width, top, bottom, scale },
    root: [scrollX, scrollY, document.documentElement.scrollWidth],
    geometry: Object.fromEntries(['body', '#workspace', '#stage', '.masthead', '.tool-dock', '.page-bar', '#tool-options']
      .map(selector => [selector, rect(selector)])),
    paper: rect('#paper'), zoom: get('#zoom-fit').textContent, stageScroll: [stage.scrollLeft, stage.scrollTop],
    focus: document.activeElement.id, mask,
    controls: Object.fromEntries(['#mark-text', '#mark-size', '#keyboard-place'].map(selector => {
      const element = get(selector), box = rect(selector);
      const hit = element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      return [selector, { ...box, hit, font: parseFloat(getComputedStyle(element).fontSize) }];
    })),
  };
}
