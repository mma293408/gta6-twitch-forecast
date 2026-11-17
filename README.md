# GTA VI Twitch Launch Forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Node.js 22 forecaster for the remaining 23 hours of the UTC launch day. It writes the 5th, 25th, 50th, 75th and 95th percentiles of concurrent Twitch viewers for each hour. It uses no external packages, network, credentials or random numbers.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/kit/input MAKEFUN_OUTPUT_DIR=/path/to/out node main.ts
```

On Windows PowerShell, set the directories with `$env:MAKEFUN_INPUT_DIR` and `$env:MAKEFUN_OUTPUT_DIR` before running `node main.ts`. In the official sandbox the defaults are `/input` and `/output`. It writes one `<id>.out` JSON file per `<id>.in` file.

## What the forecast learns

The first-hour print sets the scale. Comparable releases from the case provide log ratios of later hourly counts to their own first hours. The model gives more weight to launches with similar first-hour size, movement from the previous hour, and position relative to the previous 12 hours' peak. The platform mix and rolling versus simultaneous release also affect the weights.

Each hour combines the analogues as a distribution in log space, with a fallback component centered on the first-hour print. The later hours allow more upward movement when a category starts from a small print. When minute observations exist, the recent slope adjusts the first few forecast hours; this adjustment decays with the horizon. Hourly-only practice cases cannot validate the minute adjustment.

The official kit credits SullyGnome for the historical category averages. The repository carries no kit data and the forecaster learns from the comparables in each case at runtime.

## Local verification

```sh
node verify.mjs /path/to/kit /path/to/scratch-dev dev
node verify.mjs /path/to/kit /path/to/scratch-holdout holdout
node verify.mjs /path/to/kit /path/to/scratch-practice practice
```

The historical checks use the comparable titles in `p00.in`, excluding the GTA VI category's pre-release series. Before June 1, 2025, the development check excludes the test title from its analogue pool in each fold. The holdout check uses only the older pool as analogues. Both check sets put only data through hour 1 of the test title in the program's input, and use the later observations exclusively in the scorer. The comparison runs the kit's own starter and applies the published log pinball loss. The four official practice inputs have no labels in the kit; the practice check validates the output schema, its byte-for-byte reproducibility and its wall time.

License: MIT. This is a local submission candidate; it has no public repository or official score yet.
