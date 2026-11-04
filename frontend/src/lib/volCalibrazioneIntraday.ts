/**
 * Generato da `python execution/studio_vol_intraday.py --calibra` il 03/11/2026: non
 * modificare a mano, rilanciare lo script.
 *
 * Barre da 5 minuti SPX e VIX1D, 2023-05-02 -> 2026-11-02 (864 giornate).
 * - `fasce`: per fascia di 30 minuti dalle 9:30 ET (fascia = barra // 6) e per
 *   terzile di RV/IV (vol realizzata da inizio giornata / VIX1D), i quantili 68% e
 *   95% di |chiusura - SPX| in unita' di movimento atteso del resto da VIX1D.
 *   Fuori campione (stima 2023-24, prova 2025-26): la banda 68% conteneva la
 *   chiusura nel 73.3% dei casi, la 95% nel 96.8%; il +-1 sigma di VIX1D nel 87.3%.
 * - `divergenze`: dVIX1D(30 min) = beta x dSPX(30 min, in sigma) + alfa, dev. std
 *   del residuo (stimati 2023-24).
 */
export const VOL_INTRADAY = {"fasce": [{"fascia": 0, "bordiRvIv": [0.743, 1.08], "q": [[0.775, 1.673], [0.833, 1.75], [0.834, 1.623]]}, {"fascia": 1, "bordiRvIv": [0.868, 1.15], "q": [[0.719, 1.656], [0.76, 1.717], [0.845, 1.59]]}, {"fascia": 2, "bordiRvIv": [0.866, 1.115], "q": [[0.663, 1.585], [0.723, 1.548], [0.793, 1.54]]}, {"fascia": 3, "bordiRvIv": [0.829, 1.048], "q": [[0.616, 1.42], [0.704, 1.517], [0.749, 1.464]]}, {"fascia": 4, "bordiRvIv": [0.781, 0.985], "q": [[0.59, 1.352], [0.697, 1.586], [0.698, 1.431]]}, {"fascia": 5, "bordiRvIv": [0.737, 0.921], "q": [[0.577, 1.317], [0.649, 1.545], [0.676, 1.464]]}, {"fascia": 6, "bordiRvIv": [0.696, 0.866], "q": [[0.533, 1.273], [0.608, 1.421], [0.654, 1.459]]}, {"fascia": 7, "bordiRvIv": [0.662, 0.826], "q": [[0.528, 1.331], [0.53, 1.289], [0.655, 1.431]]}, {"fascia": 8, "bordiRvIv": [0.632, 0.791], "q": [[0.467, 1.232], [0.526, 1.231], [0.639, 1.431]]}, {"fascia": 9, "bordiRvIv": [0.615, 0.765], "q": [[0.497, 1.211], [0.55, 1.277], [0.634, 1.44]]}, {"fascia": 10, "bordiRvIv": [0.597, 0.737], "q": [[0.5, 1.168], [0.556, 1.343], [0.693, 1.481]]}, {"fascia": 11, "bordiRvIv": [0.583, 0.718], "q": [[0.53, 1.202], [0.633, 1.416], [0.702, 1.614]]}, {"fascia": 12, "bordiRvIv": [0.571, 0.699], "q": [[0.651, 1.366], [0.748, 1.698], [0.84, 1.859]]}], "barreGiorno": 78, "barrePerFascia": 6, "divergenze": {"beta": -0.3879, "alfa": 0.257, "sdResiduo": 0.4588, "sogliaSpx": 1.0, "sogliaResiduo": 0.5, "barre": 6, "barraMin": 6, "barraMax": 66, "riarmoBarre": 6}} as const;
