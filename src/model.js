export function pagesFor(source, count, imported) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${source}:${index}`, source, index, rotation: 0, marks: imported?.[index] ?? [],
  }));
}

export function documentState(source, count, imported) {
  return { pages: pagesFor(source, count, imported), fields: {} };
}

// All geometry uses unrotated PDF coordinates. A change transforms the original
// mark, never the previous preview. Images retain their immutable byte payload.
export function transformMark(mark, { op, dx, dy, factor, color, size }) {
  if (op === 'translate' && Number.isFinite(dx) && Number.isFinite(dy) && (dx || dy)) {
    return mark.points ? { ...mark, points: mark.points.map(([x, y]) => [x + dx, y + dy]) }
      : { ...mark, x: mark.x + dx, y: mark.y + dy };
  }
  if (op === 'scale' && Number.isFinite(factor) && factor > 0 && factor !== 1) {
    if (mark.points) {
      const [ax, ay] = mark.points[0];
      return { ...mark, points: mark.points.map(([x, y]) => [ax + (x - ax) * factor, ay + (y - ay) * factor]) };
    }
    if (mark.kind === 'image') return { ...mark, width: mark.width * factor, height: mark.height * factor };
    if (mark.kind === 'text') size = Math.max(1, Math.min(288, mark.size * factor));
  }
  if (mark.size !== undefined && Number.isFinite(size) && size >= 1 && size <= 288 && size !== mark.size) return { ...mark, size };
  if (mark.color && /^#[0-9a-f]{6}$/i.test(color) && color !== mark.color) return { ...mark, color };
  return mark;
}

export function edit(state, action) {
  const at = state.pages.findIndex(page => page.id === action.id);
  const page = state.pages[at];
  const replace = next => ({ ...state, pages: state.pages.map((p, i) => i === at ? next : p) });
  switch (action.type) {
    case 'blank': {
      if (!page || !action.newId || state.pages.some(p => p.id === action.newId)) return state;
      const blank = { ...page, id: action.newId, blank: true, marks: [] };
      const pages = [...state.pages];
      pages.splice(at + (action.after ? 1 : 0), 0, blank);
      return { ...state, pages };
    }
    case 'crop': {
      if (!page || !insideBox(action.box, page.crop ?? action.bounds)) return state;
      return replace({ ...page, crop: [...action.box] });
    }
    case 'splitPlan': {
      const plan = action.expression.split(';').map(part => selectPages(state.pages, part).map(p => p.id));
      return { ...state, splitPlan: plan };
    }
    case 'group': {
      const ids = new Set(action.ids);
      const group = state.pages.filter(p => ids.has(p.id));
      const rest = state.pages.filter(p => !ids.has(p.id));
      if (!group.length || ids.size !== group.length) return state;
      if (action.op === 'rotate') return { ...state, pages: state.pages.map(p => ids.has(p.id) ? { ...p, rotation: (p.rotation + 90) % 360 } : p) };
      if (action.op === 'delete') {
        if (!rest.length) return state;
        const { splitPlan, ...next } = state;
        return { ...next, pages: rest, ...(splitPlan && !splitPlan.some(part => part.some(id => ids.has(id))) ? { splitPlan } : {}) };
      }
      const pos = action.position;
      if (action.op !== 'move' || !Number.isInteger(pos) || pos < 1 || pos > rest.length + 1) return state;
      const pages = [...rest.slice(0,pos-1), ...group, ...rest.slice(pos-1)];
      return pages.every((p,i) => p === state.pages[i]) ? state : { ...state, pages };
    }
    case 'rotate':
      return page ? replace({ ...page, rotation: (page.rotation + 90) % 360 }) : state;
    case 'mark':
      return page ? replace({ ...page, marks: [...page.marks, structuredClone(action.mark)] }) : state;
    case 'stampBatch': {
      const additions = new Map(action.edits.map(({ id, marks }) => [id, marks]));
      if (!additions.size || additions.size !== action.edits.length ||
          state.pages.filter(p => additions.has(p.id)).length !== additions.size ||
          [...additions.values()].some(marks => !marks.length || marks.some(m => m.kind !== 'stamp'))) return state;
      return { ...state, pages: state.pages.map(p => additions.has(p.id)
        ? { ...p, marks: [...p.marks, ...structuredClone(additions.get(p.id))] } : p) };
    }
    case 'editMark':
    case 'removeMark': {
      const index = page?.marks.findIndex(mark => mark.markId === action.markId);
      if (!action.markId || index == null || index < 0) return state;
      const marks = [...page.marks];
      if (action.type === 'removeMark') marks.splice(index, 1);
      else {
        const next = transformMark(marks[index], action.change);
        if (next === marks[index]) return state;
        marks[index] = next;
      }
      return replace({ ...page, marks });
    }
    case 'delete':
      return !page || state.pages.length < 2 ? state : { ...state, pages: state.pages.filter(p => p !== page) };
    case 'move': {
      const to = at + action.delta;
      if (!page || !Number.isInteger(to) || to < 0 || to >= state.pages.length || to === at) return state;
      const pages = [...state.pages];
      pages.splice(at, 1);
      pages.splice(to, 0, page);
      return { ...state, pages };
    }
    case 'merge':
      return action.count > 0 && !state.pages.some(p => p.source === action.source)
        ? { ...state, pages: [...state.pages, ...pagesFor(action.source, action.count, action.marks)] } : state;
    case 'fields': {
      const previous = state.fields[action.source] ?? {};
      const values = { ...previous };
      for (const { name, value, original } of action.changes) {
        if (JSON.stringify(original) === JSON.stringify(value)) Reflect.deleteProperty(values, name);
        else Object.defineProperty(values, name, { value, enumerable: true, configurable: true });
      }
      if (JSON.stringify(previous) === JSON.stringify(values)) return state;
      return { ...state, fields: { ...state.fields, [action.source]: values } };
    }
    default:
      throw new Error(`Unknown edit: ${action.type}`);
  }
}

export function history(initial) {
  let states = [initial], index = 0, saved = initial;
  return {
    get current() { return states[index]; },
    get dirty() { return states[index] !== saved; },
    get canUndo() { return index > 0; },
    get canRedo() { return index < states.length - 1; },
    apply(action) {
      const next = edit(states[index], action);
      if (next === states[index]) return false;
      states = [...states.slice(0, index + 1), next].slice(-101);
      index = states.length - 1;
      return true;
    },
    undo() { if (this.canUndo) index--; },
    redo() { if (this.canRedo) index++; },
    checkpoint() { saved = states[index]; },
    referencesSource(id) { return states.some(state => state.pages.some(page => page.source === id)); },
  };
}

export function selectPages(pages, expression) {
  const indices = new Set();
  for (const item of expression.trim().split(/\s*,\s*/)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(item);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? start);
    if (!match || start < 1 || end < start || end > pages.length) {
      throw new Error(`Enter page numbers or ranges from 1 to ${pages.length}, such as 1, 3-5.`);
    }
    for (let index = start; index <= end; index++) indices.add(index - 1);
  }
  return pages.filter((_, index) => indices.has(index));
}

// Both boxes are [left, bottom, right, top] in unrotated page coordinates.
export function insideBox(box, bounds) {
  return [box,bounds].every(b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) &&
    box[0] < box[2] && box[1] < box[3] && box[0] >= bounds[0] && box[1] >= bounds[1] && box[2] <= bounds[2] && box[3] <= bounds[3];
}

export function rotatePoint(x, y, angle) {
  switch ((angle % 360 + 360) % 360) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}
