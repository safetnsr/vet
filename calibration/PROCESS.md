# Calibration Process

## When to recalibrate

Run calibration after:
1. **New check added** — any new check changes the score distribution
2. **Scoring logic changed** — weight adjustments, floor changes, multiplier tweaks
3. **Major version bump** — before publishing a new major version

## How to recalibrate

```bash
cd calibration
bash run-calibration.sh 120
```

This clones ~110 repos (skips >50MB), runs vet, and outputs:
- Pearson correlation (target: >0.90)
- Grade distribution
- Average scores by quality tier
- Mismatches (expected vs actual)

## Interpreting results

| correlation | status |
|---|---|
| >0.90 | ship it |
| 0.85-0.90 | investigate mismatches, likely label issues |
| 0.80-0.85 | new check may need size normalization |
| <0.80 | something is broken — do not ship |

## If correlation drops after a new check

1. **Check if the new check is size-normalized.** Large repos should not be penalized more than small ones for the same issue rate. Use the log-scale pattern:
   ```typescript
   const scale = fileCount <= 10 ? 1.0 : Math.max(0.3, 1.0 - Math.log10(fileCount / 10) * 0.4);
   ```

2. **Check which category the check is in.** If it's in integrity (9 checks), one bad score gets diluted. If it's in deps (1-2 checks), it dominates.

3. **Check the score floor.** Non-security checks have a floor of 25. If the new check frequently returns 0, consider whether 25 is appropriate.

4. **Relabel if needed.** If the new check reveals something real (e.g., a "high" repo has destructive operations), the label might be wrong.

## Adding new repos to the dataset

Labels must reflect **structural code quality**, not reputation:
- **high** = TypeScript, tests, CI, active maintenance, clean architecture
- **medium** = functional but missing some of the above (no TS, limited tests, aging)
- **low** = abandoned, no tests, stale >2 years, minimal structure

A deprecated but well-written repo is "high" or "medium", not "low".

## Current stats

- **108 repos scored** (116 in dataset, some skip due to size/clone failures)
- **Correlation: 0.91** (v1.16.0 with guard check)
- **Distribution:** high=56, medium=37, low=14
- **Tier averages:** high=89, medium=72, low=53
