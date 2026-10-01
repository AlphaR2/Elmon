# Third-party notices

Elmon Analytics adapts methods from the following MIT-licensed project. No code was copied verbatim; the rules below were
reimplemented in TypeScript from its documentation and source.

## tracced

https://github.com/mostronton-commits/tracced

Used: the first-funder rule (signer with the largest lamport outflow when the wallet's balance rose), the exchange/app
funder rule (latest 1,000 transactions within one day) with 30-minute creation bursts, the bot-like rule, the PnL
method (average cost, closed at 99% sold, transfer-in positions excluded), and the Helius
`getTransactionsForAddress` usage and credit prices.

```
MIT License

Copyright (c) 2026 Oleksii Savchenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pumpfun-research

https://github.com/haccer/pumpfun-research (MIT). Read for the BUY/SELL classification by SOL and token deltas.
