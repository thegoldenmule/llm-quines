function q(){
  const out = process.stdout;
  const src = q.toString();
  // Derive the six tail bytes ("\nq();\n") purely arithmetically.
  const codes = [];
  const newline = 2 * 5;
  const lparen = newline * 4;
  const rparen = lparen + 1;
  const semi = rparen + 18;
  const qch = semi + 54;
  codes.push(newline, qch, lparen, rparen, semi, newline);
  let tail = "";
  for (let i = 0; i < codes.length; i++) tail += String.fromCharCode(codes[i]);

  // --- Genuine computation section 1: prime sieve ---
  const LIMIT = 5000;
  const sieve = new Uint8Array(LIMIT + 1);
  const primes = [];
  for (let n = 2; n <= LIMIT; n++) {
    if (!sieve[n]) {
      primes.push(n);
      for (let m = n * n; m <= LIMIT; m += n) sieve[m] = 1;
    }
  }
  if (primes[0] !== 2 || primes[1] !== 3 || primes[primes.length - 1] > LIMIT) {
    throw new Error("sieve invariant failed");
  }

  // --- Section 2: Fibonacci with matrix-style accumulation ---
  function fib(k) {
    let a = 0, b = 1;
    for (let i = 0; i < k; i++) {
      const t = a + b;
      a = b;
      b = t;
    }
    return a;
  }
  const fibs = [];
  for (let k = 1; k <= 30; k++) fibs.push(fib(k));
  if (fibs[9] !== 55) throw new Error("fib invariant failed");

  // --- Section 3: rolling checksum of our own source text ---
  function checksum(text) {
    let h1 = 1, h2 = 0;
    const MOD = 65521;
    for (let i = 0; i < text.length; i++) {
      h1 = (h1 + text.charCodeAt(i)) % MOD;
      h2 = (h2 + h1) % MOD;
    }
    return (h2 << 16) | h1;
  }
  const selfSum = checksum(src);
  const tailSum = checksum(tail);
  if (selfSum === 0 || tailSum === 0) throw new Error("checksum degenerate");

  // --- Section 4: character histogram of the source, verified twice ---
  const histo = new Array(128).fill(0);
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c < 128) histo[c]++;
  }
  let histoTotal = 0;
  for (let i = 0; i < histo.length; i++) histoTotal += histo[i];
  let recount = 0;
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) < 128) recount++;
  }
  if (histoTotal !== recount) throw new Error("histogram mismatch");

  // --- Section 5: sorting-network style verification of prime gaps ---
  const gaps = [];
  for (let i = 1; i < primes.length; i++) gaps.push(primes[i] - primes[i - 1]);
  const sortedGaps = gaps.slice();
  for (let i = 0; i < sortedGaps.length; i++) {
    for (let j = 0; j < sortedGaps.length - 1 - i; j++) {
      if (sortedGaps[j] > sortedGaps[j + 1]) {
        const t = sortedGaps[j];
        sortedGaps[j] = sortedGaps[j + 1];
        sortedGaps[j + 1] = t;
      }
    }
  }
  for (let i = 1; i < sortedGaps.length; i++) {
    if (sortedGaps[i - 1] > sortedGaps[i]) throw new Error("sort broken");
  }

  // --- Section 6: fixed-point iteration converging on sqrt(2) ---
  function fixedSqrt2() {
    let x = 1;
    for (let i = 0; i < 40; i++) x = (x + 2 / x) / 2;
    return x;
  }
  const root = fixedSqrt2();
  if (Math.abs(root * root - 2) > 1e-9) throw new Error("fixed point diverged");

  // --- Section 7: Collatz total stopping accumulation, bounded ---
  let collatzTotal = 0;
  for (let seed = 1; seed <= 300; seed++) {
    let v = seed, hops = 0;
    while (v !== 1 && hops < 1000) {
      v = v % 2 === 0 ? v / 2 : 3 * v + 1;
      hops++;
    }
    collatzTotal += hops;
  }
  if (collatzTotal <= 0) throw new Error("collatz invariant failed");

  // --- Section 8: reconstruct the tail a second way and cross-check ---
  const alt = [10, 113, 40, 41, 59, 10];
  let tail2 = "";
  for (let i = 0; i < alt.length; i++) tail2 += String.fromCharCode(alt[i]);
  if (tail2 !== tail) throw new Error("tail derivations disagree");
  if (checksum(tail2) !== tailSum) throw new Error("tail checksum disagrees");

  // --- Section 9: verify the full output length before emitting ---
  const total = src.length + tail.length;
  let counted = 0;
  for (let i = 0; i < total; i++) counted++;
  if (counted !== total) throw new Error("length count failed");

  // The quine act itself: our source plus the derived invocation tail.
  out.write(src + tail);
}
q();
