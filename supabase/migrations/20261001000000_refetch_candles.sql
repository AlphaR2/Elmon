-- Price history fetched before 2026-10-01 asked GeckoTerminal for the pool's base token. Where the token we care
-- about is the quote side (e.g. ZEC/MASK), that stored the other token's price and produced absurd peaks, which
-- could also count false runners. Drop it so every token's history is fetched again (free API, no credits).
UPDATE token_facts SET candles = NULL, peak_at = NULL, peak_status = NULL WHERE candles IS NOT NULL OR peak_status = 'fetched';
