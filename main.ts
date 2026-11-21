// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works, in brief:
//   * The levels are a hallway with one to four small rooms off it, each room
//     holding 3 or 4 boxes and as many goals. A box pushed out of a room's door
//     can never be pushed back, so the rooms are independent problems: the
//     level is solved room by room and the push-optimal count of the whole
//     level is the sum of its rooms' optima. The rooms are found by cutting
//     the dead squares of the player's row (the hallway) out of the floor and
//     taking the connected parts that hold boxes.
//   * Each room is solved by a breadth-first search over pushes, not steps:
//     a state is the boxes' squares plus the player's reachable region (named
//     by its lowest square), so a state is one push away from the next. BFS
//     over pushes finds the fewest pushes, which is what the score pays for.
//   * Two deadlocks are pruned, neither of which can prune a solvable state:
//     a dead square (no push, ignoring the other boxes, can ever bring a box
//     from it onto a goal) and a frozen 2 x 2 block (four squares of walls
//     and boxes holding a box off its goal).
//   * If the push BFS gives up on a room, a push A* with an admissible
//     Hungarian-assignment heuristic (the cheapest way to match the boxes to
//     the goals over walking distances) takes over for that room, and if the
//     level is no set of rooms at all, a whole-level push A* is the last
//     resort. An instance no search solves gets an empty answer.
//   * The 60 second wall is budgeted by work, never by the clock: every
//     search stops after a fixed number of states, and the whole run shares
//     one state budget. No clock is read, nothing is random, and the search
//     order is fixed, so two runs answer byte for byte alike.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The work budgets, in search states. The run's one budget is shared by
// every instance, so the total work of a run is bounded whatever the levels
// hold; a search that spends its own cap gives up and the next one tries.
const BFS_ROOM_STATES = 400_000;
const ASTAR_ROOM_STATES = 800_000;
const ASTAR_WHOLE_STATES = 800_000;
const TOTAL_STATES = 6_000_000;

// The four directions, up, down, left, right. This one fixed order is the
// search's only tie-break, so the answer never depends on anything else.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP_LETTER = ['u', 'd', 'l', 'r'];
const PUSH_LETTER = ['U', 'D', 'L', 'R'];

/** A board: width, height, walls, goals, boxes and the player, on one flat grid. */
interface Board {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

/** One push of the search: the box's square before and after, and its direction. */
interface PushStep {
  from: number;
  to: number;
  dir: number;
}

/** A search's answer: its pushes, in order. */
interface SearchResult {
  pushes: number;
  path: PushStep[];
}

/** The run's shared state budget. */
interface Budget {
  left: number;
}

/** A level in XSB text, parsed onto a flat grid. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const goalSet = new Uint8Array(size);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goals.push(i);
        goalSet[i] = 1;
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, size, wall, goals, goalSet, boxes, player };
}

/**
 * The live squares: every square a box can be pushed from onto some goal,
 * found by pulling boxes back from the goals. A box on a square pulls to
 * the square behind it when both that square and the player's square beyond
 * it are open floor. Goals are live by definition; a box on a dead square
 * can never reach a goal, so a push onto one is pruned.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.size);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * b.w + DX[k];
      const y = x - d;
      if (y < 0 || y >= b.size) continue;
      if (b.wall[y] === 0 && b.wall[y - d] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The lowest square the player reaches from `from` with `occ` in the way, flood-filled with a stamp. */
function regionLow(b: Board, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const w = b.w;
  const wall = b.wall;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    let q = p - w;
    if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
    q = p + w;
    if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
    q = p - 1;
    if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
    q = p + 1;
    if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
      seen[q] = stamp;
      stack[n++] = q;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block: four
 * squares of walls and boxes, one of them a box off its goal. No push can
 * ever move a box out of such a block, so the state is dead.
 */
function frozenBlock(b: Board, occ: Uint8Array, t: number): boolean {
  const w = b.w;
  const wall = b.wall;
  const goal = b.goalSet;
  for (let k = 0; k < 4; k++) {
    const a = k === 0 ? t : k === 1 ? t - 1 : k === 2 ? t - w : t - w - 1;
    const c1 = a + 1;
    const c2 = a + w;
    const c3 = c2 + 1;
    if ((wall[a] || occ[a]) && (wall[c1] || occ[c1]) && (wall[c2] || occ[c2]) && (wall[c3] || occ[c3])) {
      if ((occ[a] && !goal[a]) || (occ[c1] && !goal[c1]) || (occ[c2] && !goal[c2]) || (occ[c3] && !goal[c3])) return true;
    }
  }
  return false;
}

/**
 * A state's key: its region's lowest square and its boxes' squares, as
 * digits in base `size` when that fits in a safe integer, else as a short
 * string of the same squares. Either way the key names the state exactly.
 */
function keyOf(boxes: number[], low: number, size: number, numeric: boolean): number | string {
  if (numeric) {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  }
  return String.fromCharCode(low, ...boxes);
}

/** Whether a base-`size` key of `count` digits stays a safe integer. */
function numericKeyFits(size: number, count: number): boolean {
  let k = 1;
  for (let i = 0; i < count; i++) {
    k *= size;
    if (k >= 2 ** 53) return false;
  }
  return true;
}

/**
 * The push-optimal solution of a board by breadth-first search over pushes,
 * or null when the search spends `maxStates` states or the shared budget.
 * States are found in order of pushes made, so the first solved state met
 * is push-optimal.
 */
function bfsPushes(b: Board, maxStates: number, budget: Budget): SearchResult | null {
  const size = b.size;
  const w = b.w;
  const live = liveSquares(b);
  const numeric = numericKeyFits(size, b.boxes.length + 1);
  const solved = (boxes: number[]): boolean => boxes.every((x) => b.goalSet[x]);
  if (b.boxes.some((x) => !live[x])) return null;
  if (solved(b.boxes)) return { pushes: 0, path: [] };

  const boxesArr: number[][] = [b.boxes.slice()];
  const playerArr: number[] = [b.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number | string, number>();
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  for (const x of b.boxes) occ[x] = 1;
  index.set(keyOf(b.boxes, regionLow(b, occ, b.player, seen, ++stamp, stack), size, numeric), 0);
  for (const x of b.boxes) occ[x] = 0;

  let found = -1;
  for (let head = 0; found < 0 && head < boxesArr.length; head++) {
    const boxes = boxesArr[head];
    for (const x of boxes) occ[x] = 1;
    regionLow(b, occ, playerArr[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        if (seen[box - d] !== here) continue;
        const t = box + d;
        if (b.wall[t] || occ[t] || !live[t]) continue;
        occ[box] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(b, occ, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          key = keyOf(next, regionLow(b, occ, box, mark, ++stamp, stack), size, numeric);
        }
        occ[t] = 0;
        occ[box] = 1;
        if (frozen || index.has(key)) continue;
        if (boxesArr.length >= maxStates || budget.left <= 0) {
          for (const x of boxes) occ[x] = 0;
          return null;
        }
        budget.left--;
        index.set(key, boxesArr.length);
        boxesArr.push(next!);
        playerArr.push(box);
        parent.push(head);
        pushFrom.push(box);
        pushTo.push(t);
        pushDir.push(k);
        if (solved(next!)) {
          found = boxesArr.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;
  const path: PushStep[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push({ from: pushFrom[s], to: pushTo[s], dir: pushDir[s] });
  path.reverse();
  return { pushes: path.length, path };
}

/** The walking distances from one square over open floor alone, -1 where unreachable. */
function distancesFrom(b: Board, from: number): Int32Array {
  const dist = new Int32Array(b.size).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * b.w + DX[k];
      if (b.wall[q] === 0 && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** Every ordering of 0..n-1, for the assignment heuristic. */
function allPerms(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/**
 * The push-optimal solution of a board by A* over pushes, or null when the
 * search spends its cap. The heuristic is the cheapest assignment of the
 * boxes to the goals over walking distances (a brute-force Hungarian for a
 * few boxes, a sum of nearest-goal distances for many), which no push can
 * shrink by more than one, so it never overestimates the pushes left and
 * the first solved state popped is push-optimal.
 */
function astarPushes(b: Board, maxStates: number, budget: Budget): SearchResult | null {
  const size = b.size;
  const w = b.w;
  const n = b.boxes.length;
  const live = liveSquares(b);
  const numeric = numericKeyFits(size, n + 1);
  const solved = (boxes: number[]): boolean => boxes.every((x) => b.goalSet[x]);
  if (b.boxes.some((x) => !live[x])) return null;
  if (solved(b.boxes)) return { pushes: 0, path: [] };

  const dist = b.goals.map((g) => distancesFrom(b, g));
  const perms = n <= 6 ? allPerms(n) : null;
  const heuristic = (boxes: number[]): number => {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dist[p[i]]![boxes[i]]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const x of boxes) {
      let m = Infinity;
      for (let gi = 0; gi < n; gi++) {
        const d = dist[gi]![x]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };
  if (heuristic(b.boxes) === Infinity) return null;

  const boxesArr: number[][] = [b.boxes.slice()];
  const playerArr: number[] = [b.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const keys: (number | string)[] = [];
  const best = new Map<number | string, number>();
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  for (const x of b.boxes) occ[x] = 1;
  const key0 = keyOf(b.boxes, regionLow(b, occ, b.player, seen, ++stamp, stack), size, numeric);
  for (const x of b.boxes) occ[x] = 0;
  keys.push(key0);
  best.set(key0, 0);

  // The open list: a heap on (f, -g, sequence), so ties go to the deeper
  // state first and then to the state found first.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([heuristic(b.boxes), 0, seq++, 0]);

  let found = -1;
  while (heap.length > 0 && found < 0) {
    const [, g, , s] = heapPop();
    if (best.get(keys[s]!) !== g) continue;
    const boxes = boxesArr[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const x of boxes) occ[x] = 1;
    regionLow(b, occ, playerArr[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        if (seen[box - d] !== here) continue;
        const t = box + d;
        if (b.wall[t] || occ[t] || !live[t]) continue;
        occ[box] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(b, occ, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          h = heuristic(next);
          if (h !== Infinity) key = keyOf(next, regionLow(b, occ, box, mark, ++stamp, stack), size, numeric);
        }
        occ[t] = 0;
        occ[box] = 1;
        if (frozen || h === Infinity) continue;
        const known = best.get(key);
        if (known !== undefined && known <= g + 1) continue;
        if (boxesArr.length >= maxStates || budget.left <= 0) {
          for (const x of boxes) occ[x] = 0;
          return null;
        }
        budget.left--;
        best.set(key, g + 1);
        keys.push(key);
        boxesArr.push(next!);
        playerArr.push(box);
        parent.push(s);
        pushFrom.push(box);
        pushTo.push(t);
        pushDir.push(k);
        heapPush([g + 1 + h, g + 1, seq++, boxesArr.length - 1]);
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;
  const path: PushStep[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push({ from: pushFrom[s], to: pushTo[s], dir: pushDir[s] });
  path.reverse();
  return { pushes: path.length, path };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters, or null when none. */
function walkTo(b: Board, occ: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(b.size).fill(-1);
  const how = new Array<string>(b.size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * b.w + DX[k];
      if (b.wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP_LETTER[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p]! + s;
  return s;
}

/** A room: its squares, its boxes and its goals. */
interface Room {
  mask: Uint8Array;
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part left
 * that holds a box is a room. Null when a box starts in the hallway, a goal
 * falls outside every part, or some part holds more or fewer boxes than
 * goals: then the level is no set of rooms.
 */
function roomsOf(b: Board): Room[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.size);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) if (!b.wall[i] && !live[i]) cut[i] = 1;
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < b.size; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * b.w + DX[k];
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ mask: new Uint8Array(b.size), boxes: [], goals: [] });
    for (const q of squares) rooms[rooms.length - 1]!.mask[q] = 1;
  }
  for (const x of b.boxes) {
    if (part[x] < 0) return null;
    rooms[part[x]]!.boxes.push(x);
  }
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The player's walk so far: where it stands, where the boxes stand, and the moves written. */
interface WalkState {
  player: number;
  cur: number[];
  moves: string;
}

/** Append a path of pushes to a walk: the walk to each push's square, then the push. False when a walk fails. */
function appendPath(b: Board, path: PushStep[], st: WalkState): boolean {
  for (const step of path) {
    const d = DY[step.dir] * b.w + DX[step.dir];
    const occ = new Uint8Array(b.size);
    for (const x of st.cur) occ[x] = 1;
    const walk = walkTo(b, occ, st.player, step.from - d);
    if (walk === null) return false;
    st.moves += walk + PUSH_LETTER[step.dir]!;
    st.player = step.from;
    const i = st.cur.indexOf(step.from);
    st.cur[i] = step.to;
    st.cur.sort((a, c) => a - c);
  }
  return true;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls, the player walking on from
 * where the last room left it. Null when a room's searches give up or a
 * walk between rooms fails.
 */
function solveByRooms(b: Board, budget: Budget): string | null {
  const rooms = roomsOf(b);
  if (rooms === null) return null;
  const st: WalkState = { player: b.player, cur: b.boxes.slice(), moves: '' };
  for (const room of rooms) {
    const wall = b.wall.slice();
    for (const x of st.cur) if (!room.mask[x]) wall[x] = 1;
    const goalSet = new Uint8Array(b.size);
    for (const g of room.goals) goalSet[g] = 1;
    const sub: Board = {
      w: b.w,
      h: b.h,
      size: b.size,
      wall,
      goals: room.goals.slice().sort((a, c) => a - c),
      goalSet,
      boxes: room.boxes.slice().sort((a, c) => a - c),
      player: st.player,
    };
    const res = bfsPushes(sub, BFS_ROOM_STATES, budget) ?? astarPushes(sub, ASTAR_ROOM_STATES, budget);
    if (res === null) return null;
    if (!appendPath(b, res.path, st)) return null;
  }
  if (!st.cur.every((x) => b.goalSet[x])) return null;
  return st.moves;
}

/** The moves that solve a level, or '' when no search solves it. */
function solveLevel(text: string, budget: Budget): string {
  const b = parseLevel(text);
  if (b.boxes.length === 0) return '';
  if (b.boxes.every((x) => b.goalSet[x])) return '';
  const byRooms = solveByRooms(b, budget);
  if (byRooms !== null) return byRooms;
  const whole = astarPushes(b, ASTAR_WHOLE_STATES, budget);
  if (whole === null) return '';
  const st: WalkState = { player: b.player, cur: b.boxes.slice(), moves: '' };
  if (!appendPath(b, whole.path, st)) return '';
  if (!st.cur.every((x) => b.goalSet[x])) return '';
  return st.moves;
}

const budget: Budget = { left: TOTAL_STATES };
for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
