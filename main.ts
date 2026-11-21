// Sokoban solver v2: push-optimal, room by room, written from scratch.
//
// A level is a hallway with independent rooms off it (a box pushed out of a
// room's door is lost, so each room's boxes stay in their room and the
// level's optimum P* is the sum of the rooms' optima). Each room is solved
// by breadth-first search over pushes: a state is the boxes plus the lowest
// square of the player's reachable region, so states that differ only in
// where the player stands inside one region collapse to one. Two prunings,
// both sound, keep the search small: a push onto a dead square (no pull-back
// path from any goal, ignoring other boxes) is never made, and a push that
// leaves a box off its goal inside a 2x2 block of walls and boxes is never
// made (no box in such a block can ever move again). Rooms are solved in
// turn with the other rooms' boxes standing as walls; the moves concatenate.
// The search is capped by states kept, never by the clock, so two runs of
// one level answer byte for byte alike.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const ML = 'udlr';
const PL = 'UDLR';
const MAXS = 250000;

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };
type Room = { boxes: number[]; goals: number[]; done: boolean };

function parse(t: string): Level {
  const rows = t.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      const i = y * w + x;
      if (c === '#') continue;
      wall[i] = 0;
      if (c === '.' || c === '*' || c === '+') goals.push(i);
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares a box can stand on and still be pushed onto some goal: pull back
// from the goals, a box at x drawable to y = x - d when y and y - d are open.
function live(wall: Uint8Array, w: number, goals: number[]): Uint8Array {
  const lv = new Uint8Array(wall.length);
  const q = [...goals];
  for (const g of goals) lv[g] = 1;
  for (let i = 0; i < q.length; i++) {
    const x = q[i];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      if (y >= 0 && y < wall.length && !wall[y] && !wall[y - d] && !lv[y]) {
        lv[y] = 1;
        q.push(y);
      }
    }
  }
  return lv;
}

// Flood the player's region from `from` around walls and boxes (marked in
// `seen` with `stamp`); answer its lowest square.
function reach(wall: Uint8Array, w: number, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (!wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a 2x2 block of walls and boxes
// with a box among them off its goal: no box in such a block can ever move.
function frozen(wall: Uint8Array, w: number, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (
      (wall[a] || occ[a]) && (wall[b] || occ[b]) && (wall[c] || occ[c]) && (wall[d] || occ[d]) &&
      ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d]))
    )
      return true;
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and boxes, lower LURD.
function walk(l: Level, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = l;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const q = [from];
  prev[from] = from;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const nq = p + DY[k] * w + DX[k];
      if (wall[nq] || occ[nq] || prev[nq] !== -1) continue;
      prev[nq] = p;
      how[nq] = ML[k];
      q.push(nq);
    }
  }
  if (prev[to] === -1) throw new Error('walk: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// Push-optimal solution of one level (one room, or a whole level as a
// fallback): {pushes, moves} in LURD, upper letters for pushes, or null.
function solve(l: Level): { pushes: number; moves: string } | null {
  const { w, wall, goals } = l;
  const n = wall.length;
  const goal = new Uint8Array(n);
  for (const g of goals) goal[g] = 1;
  const lv = live(wall, w, goals);
  const occ = new Uint8Array(n);
  const seen = new Int32Array(n);
  const mark = new Int32Array(n);
  const stack = new Int32Array(n);
  let stamp = 0;
  const solved = (b: number[]): boolean => b.every((x) => goal[x]);
  if (l.boxes.some((b) => !lv[b])) return null;
  const keyOf = (b: number[], low: number): number | string =>
    b.length > 5 ? low + ':' + b.join(',') : b.reduce((k, x) => k * n + x, low);
  const sBoxes: number[][] = [l.boxes];
  const sPlay: number[] = [l.player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const b of l.boxes) occ[b] = 1;
  index.set(keyOf(l.boxes, reach(wall, w, occ, l.player, seen, ++stamp, stack)), 0);
  for (const b of l.boxes) occ[b] = 0;
  let found = solved(l.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head];
    for (const b of boxes) occ[b] = 1;
    reach(wall, w, occ, sPlay[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occ[t] || !lv[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        let next: number[] | null = null;
        let key: number | string = -1;
        if (!frozen(wall, w, occ, goal, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, z) => a - z);
          key = keyOf(next, reach(wall, w, occ, b, mark, ++stamp, stack));
        }
        occ[t] = 0;
        occ[b] = 1;
        if (!next || index.has(key)) continue;
        if (sBoxes.length >= MAXS) return null;
        index.set(key, sBoxes.length);
        sBoxes.push(next);
        sPlay.push(b);
        parent.push(head);
        if (solved(next)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = l.player;
  let boxes = l.boxes;
  for (const s of path) {
    const nb = sBoxes[s];
    const from = boxes.find((b) => !nb.includes(b)) as number;
    const to = nb.find((b) => !boxes.includes(b)) as number;
    const d = to - from;
    const k = DY.findIndex((dy, i) => dy * w + DX[i] === d);
    for (const b of boxes) occ[b] = 1;
    moves += walk(l, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += PL[k];
    player = from;
    boxes = nb;
  }
  return { pushes: path.length, moves };
}

// The level's rooms: cut the dead squares of the player's row (the hallway:
// a box there reaches no goal) out of the floor; each part left holding
// boxes is a room. Null when the level is no set of rooms.
function roomsOf(l: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = l;
  const lv = live(wall, w, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !lv[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const sq = [s];
    part[s] = rooms.length;
    for (let i = 0; i < sq.length; i++)
      for (let k = 0; k < 4; k++) {
        const q = sq[i] + DY[k] * w + DX[k];
        if (q >= 0 && q < wall.length && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          sq.push(q);
        }
      }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The level solved room by room, the other rooms' boxes standing as walls
// (on their goals once their room is done); the player walks on from where
// the last room left it. Falls back to a whole-level search when the level
// is no set of rooms. Answers '' when a room's search gives up.
function solveLevel(l: Level): string {
  const rooms = roomsOf(l);
  if (!rooms) {
    const s = solve(l);
    return s ? s.moves : '';
  }
  let player = l.player;
  let moves = '';
  for (const room of rooms) {
    const wall = l.wall.slice();
    for (const o of rooms)
      if (o !== room) for (const b of o.done ? o.goals : o.boxes) wall[b] = 1;
    const sub: Level = {
      w: l.w,
      h: l.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const s = solve(sub);
    if (!s) return '';
    moves += s.moves;
    player = endOf(l.w, player, s.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(IN).sort()) {
  const moves = solveLevel(parse(readFileSync(join(IN, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'solution.txt'), moves + '\n');
}
