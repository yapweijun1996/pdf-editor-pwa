// Commands are expressed in absolute unrotated PDF page units. The viewer
// transforms these commands through its viewport; PDF appearances use them directly.
export const subtypes = Object.freeze({ underline: 'Underline', strikeout: 'StrikeOut', rectangle: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line' });
export const isShape = kind => Object.hasOwn(subtypes, kind);
export function geometry({ kind, points: [a, b = a], angle = 0, size }) {
  const [x,y] = a, [u,v] = b;
  const l = Math.min(x,u), r = Math.max(x,u), t = Math.max(y,v), d = Math.min(y,v);
  const cx = (l+r)/2, cy = (t+d)/2, kx = .55228475*(r-l)/2, ky = .55228475*(t-d)/2;
  const corners = [[l,t],[r,t],[l,d],[r,d]];
  const quad = ({0:[0,1,2,3],90:[2,0,3,1],180:[3,2,1,0],270:[1,3,0,2]})[angle].map(i => corners[i]);
  let path;
  switch (kind) {
    case 'underline': path = [['M',...quad[2]],['L',...quad[3]]]; break;
    case 'strikeout': path = [0,1].map(i => [i ? 'L':'M', ...quad[i].map((n,j) => (n+quad[i+2][j])/2)]); break;
    case 'rectangle': path = [['M',l,d],['L',r,d],['L',r,t],['L',l,t],['Z']]; break;
    case 'ellipse': path = [['M',r,cy],['C',r,cy+ky,cx+kx,t,cx,t],['C',cx-kx,t,l,cy+ky,l,cy],['C',l,cy-ky,cx-kx,d,cx,d],['C',cx+kx,d,r,cy-ky,r,cy],['Z']]; break;
    default: path = [['M',x,y],['L',u,v]];
      if (kind === 'arrow') {
        const len = Math.hypot(u-x,v-y) || 1, depth = Math.min(len*.6, Math.max(9,size*4));
        const dx = depth*(u-x)/len, dy = depth*(v-y)/len;
        path.push(['M',u-dx-dy*.5,v-dy+dx*.5],['L',u,v],['L',u-dx+dy*.5,v-dy-dx*.5]);
      }
  }
  const xs = [l,r], ys = [d,t];
  for (const [, ...args] of path) for (let i=0;i<args.length;i+=2) { xs.push(args[i]); ys.push(args[i+1]); }
  const pad = size/2;
  return { path, quad: quad.flat(), rect: [Math.min(...xs)-pad,Math.min(...ys)-pad,Math.max(...xs)+pad,Math.max(...ys)+pad] };
}
