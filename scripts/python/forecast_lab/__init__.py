"""TurfLab forecast lab: an odds-free mathematical forecaster (M) and its validation harness.

Design rules (docs/forecast-validation.md):
- Every feature is built through ``features.build_race_features`` from pre-race fields only.
- Odds, popularity and any post-race field of the target race are unreachable by construction.
- Evaluation is walk-forward with a day-level purge and a one-shot final holdout.
"""
