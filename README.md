[![Sokoban Solver](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/sage-otter-44/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/sage-otter-44/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban Solver

Push-optimal Sokoban solver for the [make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) `sokoban-solver-01-run-20261121`.

## How it works

Every level is a 1-wide hallway with 1–4 rooms opening off it through a single
door each. Boxes pushed through a door into the hallway can never come back, so
each box stays in its room and a level's push-optimal count P\* is the sum of
its rooms' optima. The solver exploits that structure:

1. **Decompose.** Flood-fill the board (minus the hallway row) to find each
   room, its door cell and its hallway approach cell.
2. **Solve each room independently** with push-optimal A\* over pushes:
   - State = player cell + sorted box cells (packed into one integer key).
   - Admissible heuristic = optimal min-cost bipartite matching of boxes to
     goals over precomputed BFS distances (exact for ≤4 boxes).
   - Deadlock pruning: pull-reachability dead cells (any box cell a box can
     never be pulled from, computed by reverse BFS from the goals), corner
     deadlocks, and frozen 2×2 wall/box blocks.
   - Tie-break on equal f prefers states with more boxes already on goals.
   - The exit requirement (player must be able to reach the room's approach
     cell at the end) is enforced in the goal test; if the exit-constrained
     search fails, a weighted (×3) A\* and then an unconstrained A\* are
     tried as fallbacks.
3. **Stitch.** BFS the player through the hallway between room doors and
   concatenate each room's move sequence. If decomposition ever fails, a
   full-level push-based A\* with the same deadlock rules is used instead.
4. **Deterministic.** All work budgets are fixed expansion caps — the solver
   never reads the wall clock, so two runs produce byte-identical output.

## Results

- Practice set: **1,000,000** (13/16/29/47/60 pushes — exactly P\* on all
  five instances), ~0.7 s for the whole set.
- House baseline `plain-astar` on the same practice set: 200,000 (only the
  first instance solved).
- Five additional generated sets (different seeds): **1,000,000 each**,
  every instance at exactly P\*.

## Run

```sh
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`), writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for all five instances.
Node 22, no dependencies, no network, no installs.

## License

MIT — see [LICENSE](LICENSE).
