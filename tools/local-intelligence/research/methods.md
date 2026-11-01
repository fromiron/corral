# Offline comparison methods

These helpers implement the statistical parts of [the experiment protocol](protocol.md). They do not read model artifacts, call a provider, authorize final-data exposure, or select a policy. Callers must freeze the model and policy before final evaluation and keep development, final, natural-record, and synthetic reports separate.

## Probability calibration

`fit_temperature(rows, predictions)` accepts only effort rows from C (`split: calibration`) and an exact one-to-one set of four-label raw-logit predictions. It fits one positive temperature by minimizing negative log likelihood. Each original group receives equal weight, shared among its variants. Temperature 1 is included as a candidate, so fitting cannot worsen the recorded calibration objective. The result records temperature bounds, group count, and before/after negative log likelihood, multiclass Brier score (sum over four classes), and top-label expected calibration error in equal-width confidence bins. These are teacher-label agreement/calibration metrics, not executable task success.

## Paired group bootstrap

Meeting comparisons average valid-dispatch indicators within each original group, then weight groups equally. Bootstrap draws sample whole groups with replacement, retaining the candidate/reference pairing. Duplicating a group's variants does not increase its independent sample count or weight. The interval is a two-sided percentile interval; the report records its random seed and resample count.

Token reduction is `1 - mean(candidate group token means) / mean(reference group token means)`. It is a ratio of aggregate token use, not an average of per-case percentage savings. Token totals must be positive provider-reported counts. Reasoning/cache counts must not be added again if already included in the provider's total. The same whole-group bootstrap supplies its interval. The bootstrap is an approximate sampling interval; it cannot establish transport comparability, fixture quality, or coverage of unseen task distributions. The pairing and percentile construction follow the definitions in [SciPy's bootstrap documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html).

## Executable success non-inferiority

The outcome helper requires the exact frozen set of independent task families and exactly two paired repeats, numbered 0 and 1, per family. It rejects missing pairs, duplicate pairs, missing families, non-Boolean success, and missing/invalid token use. This prevents missing provider outcomes from silently becoming successes, zero-cost trials, or a reduced denominator. A caller must resolve or separately report incomplete trials before constructing a qualifying cohort.

For each family let `D` be the mean of its two paired binary success differences (candidate minus fixed high). Thus `D` is one of `-1, -0.5, 0, 0.5, 1`. Let `p- = P(D < 0)` and `p+ = P(D > 0)`. Two population lower bounds are:

- `E[D] >= -p-`.
- `E[D] >= 0.5 p+ - p-`.

For a requested one-sided error rate `alpha`, bound A uses the exact one-sided Clopper–Pearson upper bound on `p-` at error `alpha/2`. Bound B uses a Clopper–Pearson lower bound on `p+` and upper bound on `p-`, each at error `alpha/4`. By the union bound, both resulting bounds hold simultaneously with probability at least `1-alpha`; their maximum is therefore a conservative lower bound. No independence between these bound events is assumed. Independent, exchangeable sampled families are assumed; the two repeats within a family need not be independent. The estimand is mean per-family, per-repeat success, not success on every repeat. [SciPy documents the underlying exact Clopper–Pearson binomial interval](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats._result_classes.BinomTestResult.proportion_ci.html); the combination of bounds is derived above.

At 200 families with no negative or positive family differences, the one-sided 95% lower bound is approximately `-1.83` percentage points, not zero. Repeats do not turn 200 families into 400 independent observations. This deliberately conservative method can be underpowered when gains offset losses; a failed bound means insufficient evidence, not proof of inferiority.

The outcome gate requires at least 200 families, confidence at least 95%, this lower bound at least `-0.02`, point token reduction at least `0.10`, and a token-reduction interval whose lower endpoint is strictly positive. Lower confidence may be requested for diagnostics but cannot qualify the gate. Those are separate statistical conditions, not a claim of a joint 95% confidence region. Runtime limits and other release conditions remain additional requirements outside this helper.
