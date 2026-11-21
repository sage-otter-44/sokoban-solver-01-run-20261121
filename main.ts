// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy: the generator builds each level from a 1-wide hallway plus 1-4
// rooms (3-4 boxes each, one door each). Boxes never leave their room in an
// optimal solution and the level's push-optimal count P* is the sum of the
// rooms' optima, so each room is solved INDEPENDENTLY with a push-optimal
// A* over pushes, then the rooms are stitched together by walking the
// player through the hallway. A full-level push A* is kept as a fallback
// for levels whose structure does not decompose.
//
// The search is deterministic: every budget is a fixed expansion count, the
// clock is never read, and identical runs produce identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// Shared deterministic work budget (expansion counts, never wall time).
const BUDGET = { used: 0, total: 6_000_000 };
const ROOM_CAP = 1_000_000;
const FALLBACK_CAP = 400_000;

// ---------------------------------------------------------------- parsing

interface Parsed {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Parsed {
  const rows = text
    .split('\n')
    .map((r) => r.replace(/\r$/, ''))
    .filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

// ------------------------------------------------------------ room finding

interface Room {
  cells: number[]; // global indices of the room's floor cells
  door: number; // global index of the door cell (inside the room)
  approach: number; // global index of the hallway cell just outside the door
  boxes: number[];
  goals: number[];
}

function detectRooms(p: Parsed): Room[] | null {
  const { w, h, wall, goal, boxes, player } = p;
  const yH = Math.floor(player / w);
  for (const b of boxes) if (Math.floor(b / w) === yH) return null;
  for (let i = 0; i < w * h; i++) {
    if (goal[i] && Math.floor(i / w) === yH) return null;
  }
  const boxSet = new Set(boxes);
  const goalCells: number[] = [];
  for (let i = 0; i < w * h; i++) if (goal[i]) goalCells.push(i);
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || Math.floor(s / w) === yH || seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      comp.push(c);
      const x = c % w;
      const y = Math.floor(c / w);
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (wall[n] || Math.floor(n / w) === yH || seen[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const compBoxes = comp.filter((c) => boxSet.has(c));
    const compGoals = comp.filter((c) => goal[c] === 1);
    if (compBoxes.length === 0 && compGoals.length === 0) continue;
    if (compBoxes.length === 0 || compGoals.length === 0) return null;
    if (compBoxes.length !== compGoals.length) return null;
    let door = -1;
    let approach = -1;
    for (const c of comp) {
      const x = c % w;
      const y = Math.floor(c / w);
      if (Math.abs(y - yH) !== 1) continue;
      const a = yH * w + x;
      if (!wall[a]) {
        door = c;
        approach = a;
        break;
      }
    }
    if (door < 0) return null;
    rooms.push({ cells: comp, door, approach, boxes: compBoxes, goals: compGoals });
  }
  const covered = new Set<number>();
  for (const r of rooms) for (const c of r.cells) covered.add(c);
  for (const b of boxes) if (!covered.has(b)) return null;
  for (const g of goalCells) if (!covered.has(g)) return null;
  rooms.sort((a, b) => a.door % w - b.door % w);
  return rooms;
}

// ------------------------------------------------------- push-based search

interface SearchOpts {
  moveCells: number[]; // global cells the player may occupy
  boxCells: number[]; // global cells boxes may occupy (subset of moveCells)
  goals: number[]; // global goal cells
  startPlayer: number; // global cell
  startBoxes: number[]; // sorted global cells
  exitCell: number; // global cell the player must be able to reach at the end, or -1
  cap: number; // max expansions for this search
  weight: number; // A* weight (1 = optimal)
}

interface SearchResult {
  moves: string;
  pushes: number;
  finalBoxes: number[];
  finalPlayer: number;
}

function pushSearch(p: Parsed, opts: SearchOpts): SearchResult | null {
  const { w, h, wall } = p;
  const k = opts.startBoxes.length;
  const moveSet = new Set(opts.moveCells);
  const boxSet = new Set(opts.boxCells);
  const goalSet = new Set(opts.goals);
  // Local indexing over moveCells (+ boxCells are inside moveCells).
  const cells = opts.moveCells.slice();
  const local = new Map<number, number>();
  cells.forEach((g, i) => local.set(g, i));
  const m = cells.length;
  const gx = cells.map((g) => g % w);
  const gy = cells.map((g) => Math.floor(g / w));
  // Adjacency within moveCells.
  const adj: number[][] = cells.map(() => []);
  for (let i = 0; i < m; i++) {
    for (let d = 0; d < 4; d++) {
      const nx = gx[i] + DIRS[d].dx;
      const ny = gy[i] + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const g = ny * w + nx;
      const j = local.get(g);
      if (j !== undefined) adj[i].push(j * 4 + d);
    }
  }
  // BFS distances between box cells (for the matching heuristic).
  const boxIdx = opts.boxCells.map((g) => local.get(g) as number);
  const nb = boxIdx.length;
  const dist: number[][] = [];
  for (let s = 0; s < nb; s++) {
    const row = new Array<number>(nb).fill(Infinity);
    const start = boxIdx[s];
    const seen = new Int32Array(m).fill(-1);
    const q = [start];
    seen[start] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      for (const e of adj[c]) {
        const n = Math.floor(e / 4);
        if (!boxSet.has(cells[n]) || seen[n] >= 0) continue;
        seen[n] = seen[c] + 1;
        q.push(n);
      }
    }
    for (let t = 0; t < nb; t++) row[t] = seen[boxIdx[t]];
    dist.push(row);
  }
  const goalLocal = opts.goals.map((g) => local.get(g) as number);
  const goalBoxPos = goalLocal.map((g) => boxIdx.indexOf(g));
  // isGoalBoxCell[bi] = 1 when box cell bi is a goal (indexed by box-cell position).
  const isGoalBoxCell = new Uint8Array(nb);
  for (const gp of goalBoxPos) if (gp >= 0) isGoalBoxCell[gp] = 1;
  // Dead cells: reverse pull reachability from the goals. A non-goal cell a
  // box can never be pulled from is dead; pruning boxes on dead cells is
  // safe because the relaxation only over-approximates pullability.
  const live = new Uint8Array(nb).fill(0);
  const liveQ: number[] = [];
  for (let t = 0; t < nb; t++) {
    if (isGoalBoxCell[t]) {
      live[t] = 1;
      liveQ.push(t);
    }
  }
  for (let qi = 0; qi < liveQ.length; qi++) {
    const b = liveQ[qi];
    // Pull: box at cells[boxIdx[b]] came from a neighbour; the player must
    // have stood two steps beyond. Enumerate the four pull directions.
    const bx = gx[boxIdx[b]];
    const by = gy[boxIdx[b]];
    for (let d = 0; d < 4; d++) {
      const ax = bx - DIRS[d].dx;
      const ay = by - DIRS[d].dy;
      const px = bx - 2 * DIRS[d].dx;
      const py = by - 2 * DIRS[d].dy;
      if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const ag = ay * w + ax;
      const pg = py * w + px;
      const ai = boxIdx.indexOf(local.get(ag) as number);
      if (ai < 0 || live[ai]) continue;
      if (!moveSet.has(pg)) continue;
      live[ai] = 1;
      liveQ.push(ai);
    }
  }
  const dead = new Uint8Array(nb);
  for (let t = 0; t < nb; t++) {
    if (!live[t] && !isGoalBoxCell[t]) dead[t] = 1;
  }
  const isDeadCell = (g: number): boolean => {
    const li = local.get(g);
    if (li === undefined) return true;
    const bi = boxIdx.indexOf(li);
    return bi >= 0 ? dead[bi] === 1 : false;
  };

  // State packing: numeric when small, string otherwise.
  const numeric = m <= 64 && nb <= 64 && k <= 4;
  const packBoxes = (bs: number[]): number | string => {
    if (numeric) {
      let key = 0;
      for (let i = 0; i < 4; i++) key |= (i < bs.length ? bs[i] : 63) << (6 * i);
      return key;
    }
    return bs.join(',');
  };
  const packState = (pl: number, bs: number[]): number | string => {
    const bk = packBoxes(bs);
    return numeric ? pl | ((bk as number) << 6) : `${pl}|${bk as string}`;
  };
  const unpackBoxes = (key: number | string): number[] => {
    if (numeric) {
      const bk = (key as number) >> 6;
      const out: number[] = [];
      for (let i = 0; i < k; i++) out.push((bk >> (6 * i)) & 63);
      return out;
    }
    return (key as string).split('|')[1].split(',').map(Number);
  };
  const unpackPlayer = (key: number | string): number => {
    if (numeric) return (key as number) & 63;
    return Number((key as string).split('|')[0]);
  };

  // Heuristic: exact min-cost matching boxes -> goals over BFS distances.
  const hCache = new Map<number | string, number>();
  const heuristic = (bs: number[]): number => {
    const bk = packBoxes(bs);
    const hit = hCache.get(bk);
    if (hit !== undefined) return hit;
    let best = Infinity;
    const perm = goalBoxPos.slice();
    const use = (arr: number[], n: number): void => {
      if (n === 1) {
        let s = 0;
        for (let i = 0; i < k; i++) {
          const d = dist[bs[i]][arr[i]];
          if (!isFinite(d)) return;
          s += d;
        }
        if (s < best) best = s;
        return;
      }
      for (let i = 0; i < n; i++) {
        use(arr, n - 1);
        const j = n % 2 === 1 ? 0 : i;
        const tmp = arr[j];
        arr[j] = arr[n - 1];
        arr[n - 1] = tmp;
      }
    };
    use(perm, k);
    hCache.set(bk, best);
    return best;
  };

  const startPlayer = local.get(opts.startPlayer) as number;
  const startBoxes = opts.startBoxes.map((g) => boxIdx.indexOf(local.get(g) as number));
  startBoxes.sort((a, b) => a - b);
  for (const b of startBoxes) if (dead[b] && !isGoalBoxCell[b]) return null;
  if (!isFinite(heuristic(startBoxes))) return null;

  // A* over pushes. Nodes also carry how many boxes are already on goals:
  // on an f tie the search prefers the state that has made more progress,
  // which cuts expansions on hard rooms without changing optimality (the
  // tie-break only orders equal-f nodes; g + h still decides the optimum).
  const startKey = packState(startPlayer, startBoxes);
  const keys: (number | string)[] = [startKey];
  const gs: number[] = [0];
  const onGoal: number[] = [startBoxes.filter((b) => isGoalBoxCell[b]).length];
  const parent: number[] = [-1];
  const pbox: number[] = [-1];
  const pdir: number[] = [-1];
  const best = new Map<number | string, number>([[startKey, 0]]);
  const heap: number[] = [0];
  const fs: number[] = [heuristic(startBoxes) * opts.weight];
  const heapLess = (a: number, b: number): boolean =>
    fs[a] < fs[b] ||
    (fs[a] === fs[b] &&
      (onGoal[a] > onGoal[b] || (onGoal[a] === onGoal[b] && gs[a] > gs[b])));
  const heapPush = (id: number): void => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[par])) break;
      const t = heap[i];
      heap[i] = heap[par];
      heap[par] = t;
      i = par;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && heapLess(heap[l], heap[s])) s = l;
        if (r < heap.length && heapLess(heap[r], heap[s])) s = r;
        if (s === i) break;
        const t = heap[i];
        heap[i] = heap[s];
        heap[s] = t;
        i = s;
      }
    }
    return top;
  };

  const exitLocal = opts.exitCell >= 0 ? (local.get(opts.exitCell) as number) : -1;
  const reach = new Uint8Array(m);
  const stack: number[] = [];
  let expansions = 0;
  while (heap.length > 0) {
    const id = heapPop();
    const key = keys[id];
    const g = gs[id];
    if (best.get(key) !== g) continue;
    if (BUDGET.used >= BUDGET.total || expansions >= opts.cap) return null;
    BUDGET.used++;
    expansions++;
    const pl = unpackPlayer(key);
    const bs = unpackBoxes(key);
    // Goal test: every box on a goal, and the player can reach the exit.
    let solved = true;
    for (const b of bs) if (!isGoalBoxCell[b]) { solved = false; break; }
    if (solved && exitLocal >= 0) {
      reach.fill(0);
      stack.length = 0;
      stack.push(pl);
      reach[pl] = 1;
      const boxHere = new Set(bs.map((x) => boxIdx[x]));
      let found = false;
      while (stack.length > 0) {
        const c = stack.pop() as number;
        if (c === exitLocal) { found = true; break; }
        for (const e of adj[c]) {
          const n = Math.floor(e / 4);
          if (reach[n] || boxHere.has(n)) continue;
          reach[n] = 1;
          stack.push(n);
        }
      }
      if (!found) solved = false;
    }
    if (solved) {
      // Reconstruct the full move string.
      const segs: string[] = [];
      let cur = id;
      while (parent[cur] >= 0) {
        const par = parent[cur];
        const pk = keys[par];
        const ppl = unpackPlayer(pk);
        const pbs = unpackBoxes(pk);
        const bj = pbox[cur];
        const d = pdir[cur];
        const boxCell = pbs[bj];
        const pushCell = (() => {
          const bx = gx[boxIdx[boxCell]] - DIRS[d].dx;
          const by = gy[boxIdx[boxCell]] - DIRS[d].dy;
          return local.get(by * w + bx) as number;
        })();
        // Walk the player from ppl to pushCell in the parent state.
        const boxHere = new Set(pbs.map((x) => boxIdx[x]));
        const prev = new Int32Array(m).fill(-1);
        const prevDir = new Int8Array(m).fill(-1);
        const q = [ppl];
        prev[ppl] = ppl;
        for (let qi = 0; qi < q.length; qi++) {
          const c = q[qi];
          if (c === pushCell) break;
          for (const e of adj[c]) {
            const n = Math.floor(e / 4);
            if (prev[n] >= 0 || boxHere.has(n)) continue;
            prev[n] = c;
            prevDir[n] = e % 4;
            q.push(n);
          }
        }
        const walk: string[] = [];
        let c = pushCell;
        while (c !== ppl) {
          walk.push(DIRS[prevDir[c]].ch);
          c = prev[c];
        }
        walk.reverse();
        segs.push(walk.join('') + DIRS[d].ch);
        cur = par;
      }
      segs.reverse();
      return {
        moves: segs.join(''),
        pushes: g,
        finalBoxes: bs.map((b) => cells[boxIdx[b]]),
        finalPlayer: cells[pl],
      };
    }
    // Expand: flood fill the player's reachable cells (boxes are walls).
    reach.fill(0);
    stack.length = 0;
    stack.push(pl);
    reach[pl] = 1;
    const boxHere = new Set(bs.map((x) => boxIdx[x]));
    while (stack.length > 0) {
      const c = stack.pop() as number;
      for (const e of adj[c]) {
        const n = Math.floor(e / 4);
        if (reach[n] || boxHere.has(n)) continue;
        reach[n] = 1;
        stack.push(n);
      }
    }
    for (let bi = 0; bi < k; bi++) {
      const b = bs[bi];
      const bx = gx[boxIdx[b]];
      const by = gy[boxIdx[b]];
      for (let d = 0; d < 4; d++) {
        const dx = bx + DIRS[d].dx;
        const dy = by + DIRS[d].dy;
        if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
        const destG = dy * w + dx;
        const dest = local.get(destG);
        if (dest === undefined || !boxSet.has(destG)) continue;
        if (boxHere.has(dest)) continue;
        const destBi = boxIdx.indexOf(dest);
        if (dead[destBi] && !isGoalBoxCell[destBi]) continue;
        // 2x2 frozen block check on the moved box. Occupancy in the NEW
        // state: the old box cell is empty, the dest cell holds the box.
        // A 2x2 block of walls/boxes containing an off-goal box is frozen:
        // none of its boxes can ever move again.
        let frozen = false;
        for (let sy = -1; sy <= 0 && !frozen; sy++) {
          for (let sx = -1; sx <= 0 && !frozen; sx++) {
            const cx = dx + sx;
            const cy = dy + sy;
            let allBlocked = true;
            let hasOffGoalBox = false;
            for (let oy = 0; oy < 2; oy++) {
              for (let ox = 0; ox < 2; ox++) {
                const ccx = cx + ox;
                const ccy = cy + oy;
                if (ccx < 0 || ccy < 0 || ccx >= w || ccy >= h) continue;
                const cg = ccy * w + ccx;
                const cl = local.get(cg);
                if (cl !== undefined && boxSet.has(cg)) {
                  const occupied = (boxHere.has(cl) && cl !== boxIdx[b]) || cl === dest;
                  if (occupied) {
                    if (!isGoalBoxCell[boxIdx.indexOf(cl)]) hasOffGoalBox = true;
                  } else {
                    allBlocked = false;
                  }
                } else if (cl === undefined || wall[cg]) {
                  // wall or outside the region: blocked
                } else {
                  allBlocked = false;
                }
              }
            }
            if (allBlocked && hasOffGoalBox) frozen = true;
          }
        }
        if (frozen) continue;
        const pushCell = (() => {
          const px = bx - DIRS[d].dx;
          const py = by - DIRS[d].dy;
          return local.get(py * w + px);
        })();
        if (pushCell === undefined || !reach[pushCell]) continue;
        const nbs = bs.slice();
        nbs[bi] = dest;
        nbs.sort((a, b) => a - b);
        const hh = heuristic(nbs);
        if (!isFinite(hh)) continue;
        const nkey = packState(boxIdx[b], nbs);
        const ng = g + 1;
        const prevBest = best.get(nkey);
        if (prevBest !== undefined && prevBest <= ng) continue;
        best.set(nkey, ng);
        const nid = keys.length;
        keys.push(nkey);
        gs.push(ng);
        onGoal.push(nbs.filter((b) => isGoalBoxCell[b]).length);
        parent.push(id);
        pbox.push(bi);
        pdir.push(d);
        fs.push((ng + hh * opts.weight) as number);
        heapPush(nid);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ solver

function bfsWalk(
  p: Parsed,
  from: number,
  to: number,
  blocked: Set<number>,
): string | null {
  const { w, h, wall } = p;
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const prevDir = new Int8Array(w * h).fill(-1);
  const q = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === to) break;
    const x = c % w;
    const y = Math.floor(c / w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d].dx;
      const ny = y + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (wall[n] || blocked.has(n) || prev[n] >= 0) continue;
      prev[n] = c;
      prevDir[n] = d;
      q.push(n);
    }
  }
  if (prev[to] < 0) return null;
  const out: string[] = [];
  let c = to;
  while (c !== from) {
    out.push(DIRS[prevDir[c]].ch);
    c = prev[c];
  }
  out.reverse();
  return out.join('');
}

function solveLevel(p: Parsed): string {
  const rooms = detectRooms(p);
  if (rooms !== null) {
    // Solve rooms one at a time, stitching through the hallway.
    let moves = '';
    let player = p.player;
    const liveBoxes = new Set(p.boxes);
    let ok = true;
    for (const room of rooms) {
      const walk = bfsWalk(p, player, room.approach, liveBoxes);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      player = room.approach;
      const moveCells = room.cells.concat([room.approach]);
      let res = pushSearch(p, {
        moveCells,
        boxCells: room.cells,
        goals: room.goals,
        startPlayer: room.approach,
        startBoxes: room.boxes,
        exitCell: room.door,
        cap: ROOM_CAP,
        weight: 1,
      });
      if (res === null) {
        // Weighted retry: any complete solution beats none.
        res = pushSearch(p, {
          moveCells,
          boxCells: room.cells,
          goals: room.goals,
          startPlayer: room.approach,
          startBoxes: room.boxes,
          exitCell: room.door,
          cap: ROOM_CAP,
          weight: 3,
        });
      }
      if (res === null) {
        // Last try without the exit requirement.
        res = pushSearch(p, {
          moveCells,
          boxCells: room.cells,
          goals: room.goals,
          startPlayer: room.approach,
          startBoxes: room.boxes,
          exitCell: -1,
          cap: ROOM_CAP,
          weight: 1,
        });
      }
      if (res === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      for (const b of room.boxes) liveBoxes.delete(b);
      for (const b of res.finalBoxes) liveBoxes.add(b);
      player = res.finalPlayer;
    }
    if (ok) return moves;
  }
  // Fallback: full-level push A*.
  const floor: number[] = [];
  for (let i = 0; i < p.w * p.h; i++) if (!p.wall[i]) floor.push(i);
  const goals: number[] = [];
  for (let i = 0; i < p.w * p.h; i++) if (p.goal[i]) goals.push(i);
  const res = pushSearch(p, {
    moveCells: floor,
    boxCells: floor,
    goals,
    startPlayer: p.player,
    startBoxes: p.boxes,
    exitCell: -1,
    cap: FALLBACK_CAP,
    weight: 1,
  });
  return res === null ? '' : res.moves;
}

// --------------------------------------------------------------------- main

for (const id of readdirSync(INPUT_DIR).sort()) {
  const levelText = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
  const parsed = parseLevel(levelText);
  const moves = solveLevel(parsed);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
