# Infrastructure Performance

Text to speech performance.

Prevent buffering and choppy sound when generating speech.

## GPU Card

Measure Text to Speech Generation speed early:

```bash
(gen x) = (audio seconds produced) / (wall clock seconds elapsed)
```

This tells us the key truth:

- If **`gen x < 1.0`** for significant periods, the TTS stream is arriving **slower than realtime** → you will inevitably get underruns/chops unless you add more buffering (delay) or pause/rebuffer.
- If **`gen x >= 1.0`** consistently, then underruns are coming from client-side issues.


| Card Details | Cores | AMI Instance Type | Gen-X |
|--------------|-------|-------------------|-------|
| NVIDIA L4 - 24 GB | 7,424 CUDA Cores, 240 Tensor Cores (Gen 4), 60 RT Cores (Gen 3) | g6-8xlarge | 0.78 |
| NVIDIA L40S - 48 GB | 18,176 CUDA Cores, 568 Tensor Cores (Gen 4), 142 RT Cores (Gen 3) | g6e-xlarge | 1.95 |

![./images/gen-x.png](images/gen-x.png)

## Client architecture

Javascript client architecture [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer) ring - shared-memory ring buffer (SharedArrayBuffer + Atomics) between main thread and worklet to eliminate per-chunk messaging entirely.
