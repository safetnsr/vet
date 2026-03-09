# vet calibration data

Empirical calibration of vet's scoring against 43 public repos.

**Correlation: 0.83** (pearson, expected quality vs actual score)

## Dataset

`repos.json` — 43 npm packages labeled by structural code quality:
- **high** (27): typed, tested, CI, actively maintained
- **medium** (11): functional but aging, limited tests/types
- **low** (5): abandoned, no tests, stale

## Results

`results/` — JSONL files from each calibration run, tracking correlation improvements across 13 iterations.

## Reproducing

```bash
# clone test repos
bash run-calibration.sh

# or use autotune for automated iteration
npx @safetnsr/autotune run
```

## Article

Full writeup: [from -0.32 to +0.83](https://comrade.md/writing/calibrating-vet-with-autoresearch)
