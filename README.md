# Sokoban Solver — push-optimal, 5/5 at P*

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/adewahid/makefun-sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/adewahid/makefun-sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty ($100 in USDC).

## How it works

The levels are a hallway with one to four small rooms off it, each holding 3 or 4 boxes and as many goals. A box pushed out of a room's door can never be pushed back, so the rooms are independent problems: the level is solved room by room, and the push-optimal count of the whole level is the sum of its rooms' optima.

- Each room is solved by a breadth-first search over pushes, not steps: a state is the boxes' squares plus the player's reachable region, so a state is one push away from the next. BFS over pushes finds the fewest pushes, which is what the score pays for.
- Two deadlocks are pruned, neither of which can prune a solvable state: dead squares and frozen 2×2 blocks.
- If the push BFS gives up on a room, a push A* with an admissible Hungarian-assignment heuristic takes over.
- Deterministic work-budgeted search: no clock reads, so two runs produce byte-identical output.

## Results

- Practice score **1,000,000** — all 5 practice instances solved at P* (13/16/29/47/60 pushes), 5/5 answered.
- House baseline (plain-astar 1.0.0): 200,000 (only i001 solved).
- Runtime ~1.6 s for the whole set (60 s wall).
- Stress test: 8 fresh sets (40 unseen levels) drawn from the kit's generator — all 1,000,000, every instance at P*.

## Run it

`main.ts` runs on Node 22 (TypeScript stripped natively). It reads each instance from `/input/<id>/` and writes `/output/<id>/solution.txt`.

## Referral

Made with Muse for make.fun — referral code `zsgcm8j7`: https://make.fun/r/zsgcm8j7
