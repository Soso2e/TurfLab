"""Conditional logit (Bolton-Chapman / Benter stage 1) with ridge, plus PL top-3 probabilities."""
from __future__ import annotations

import numpy as np


class Stack:
    """Races stacked into one matrix so softmax/grad/Hessian are vectorised with reduceat."""

    def __init__(self, Xs: list[np.ndarray], winners: list[int], race_weights: list[float] | None = None):
        self.sizes = np.array([len(x) for x in Xs])
        self.starts = np.concatenate([[0], np.cumsum(self.sizes)[:-1]])
        self.X = np.vstack(Xs)
        self.win_rows = self.starts + np.array(winners)
        if race_weights is None:
            self.race_w = np.ones(len(Xs), dtype=float)
        else:
            self.race_w = np.asarray(race_weights, dtype=float)
        self.row_w = np.repeat(self.race_w, self.sizes)

    def probs(self, beta: np.ndarray) -> np.ndarray:
        z = self.X @ beta
        m = np.maximum.reduceat(z, self.starts)
        e = np.exp(z - np.repeat(m, self.sizes))
        return e / np.repeat(np.add.reduceat(e, self.starts), self.sizes)

    def nll(self, beta: np.ndarray) -> float:
        z = self.X @ beta
        m = np.maximum.reduceat(z, self.starts)
        lse = m + np.log(np.add.reduceat(np.exp(z - np.repeat(m, self.sizes)), self.starts))
        return float(np.sum(self.race_w * (lse - z[self.win_rows])))


def fit_clogit(Xs: list[np.ndarray], winners: list[int], ridge: float, iters: int = 40,
               race_weights: list[float] | None = None) -> np.ndarray:
    st = Stack(Xs, winners, race_weights=race_weights)
    p = st.X.shape[1]
    beta = np.zeros(p)
    xw = (st.X[st.win_rows] * st.race_w[:, None]).sum(axis=0)

    def objective(b: np.ndarray) -> float:
        return st.nll(b) + 0.5 * ridge * float(b @ b)

    cur = objective(beta)
    for _ in range(iters):
        pr = st.probs(beta)
        w_pr = st.row_w * pr
        grad = st.X.T @ w_pr - xw + ridge * beta
        weighted = st.X * w_pr[:, None]
        s = np.add.reduceat(st.X * pr[:, None], st.starts, axis=0)
        sw = np.add.reduceat(weighted, st.starts, axis=0)
        hess = st.X.T @ weighted - sw.T @ s + ridge * np.eye(p)
        step = np.linalg.solve(hess, grad)
        t, val, cand = 1.0, cur, beta
        while t > 1e-4:
            cand = beta - t * step
            val = objective(cand)
            if val <= cur:
                break
            t /= 2
        else:
            break
        converged = abs(cur - val) < 1e-9 * max(1.0, abs(cur))
        beta, cur = cand, val
        if converged:
            break
    return beta


class Standardizer:
    def fit(self, Xs: list[np.ndarray]) -> "Standardizer":
        X = np.vstack(Xs)
        self.mean = X.mean(axis=0)
        sd = X.std(axis=0)
        self.sd = np.where(sd < 1e-9, 1.0, sd)
        return self

    def apply(self, X: np.ndarray) -> np.ndarray:
        return (X - self.mean) / self.sd


class ConditionalLogit:
    """Win-probability model over a feature subset. Ridge chosen by a chronological inner split."""

    def __init__(self, columns: list[int], ridge_grid=(1.0, 10.0, 100.0)):
        self.columns, self.ridge_grid = columns, ridge_grid

    def fit(self, Xs: list[np.ndarray], winners: list[int],
            race_weights: list[float] | None = None) -> "ConditionalLogit":
        sub = [x[:, self.columns] for x in Xs]
        self.std = Standardizer().fit(sub)
        z = [self.std.apply(x) for x in sub]
        if len(self.ridge_grid) > 1 and len(z) >= 60:
            cut = int(len(z) * 0.8)  # Xs are in date order, so this split never looks ahead
            best, best_loss = self.ridge_grid[-1], float("inf")
            w_train = race_weights[:cut] if race_weights is not None else None
            w_val = race_weights[cut:] if race_weights is not None else None
            for lam in self.ridge_grid:
                b = fit_clogit(z[:cut], winners[:cut], lam, race_weights=w_train)
                loss = Stack(z[cut:], winners[cut:], race_weights=w_val).nll(b) / max(1, len(z) - cut)
                if loss < best_loss:
                    best, best_loss = lam, loss
            self.ridge = best
        else:
            self.ridge = self.ridge_grid[-1]
        self.beta = fit_clogit(z, winners, self.ridge, race_weights=race_weights)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        z = self.std.apply(X[:, self.columns]) @ self.beta
        e = np.exp(z - z.max())
        return e / e.sum()


def uniform(n: int) -> np.ndarray:
    return np.full(n, 1.0 / n)


def top3_probabilities(p: np.ndarray) -> np.ndarray:
    """Exact Plackett-Luce probability that each horse finishes in the top three."""
    n = len(p)
    if n < 3:
        return np.ones(n)
    p1, p2, p3 = p[:, None, None], p[None, :, None], p[None, None, :]
    d1 = np.clip(1 - p1, 1e-12, None)
    d2 = np.clip(1 - p1 - p2, 1e-12, None)
    t = p1 * p2 / d1 * p3 / d2
    i = np.arange(n)
    distinct = (i[:, None, None] != i[None, :, None]) & (i[:, None, None] != i[None, None, :]) \
        & (i[None, :, None] != i[None, None, :])
    t = np.where(distinct, t, 0.0)
    return t.sum(axis=(1, 2)) + t.sum(axis=(0, 2)) + t.sum(axis=(0, 1))
