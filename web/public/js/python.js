// Main-thread client for python-worker.js: one run at a time, with timeouts.
// Runs are serialised because Pyodide is single-threaded anyway, and it keeps
// "which run timed out" unambiguous.

const LOAD_TIMEOUT_MS = 120_000; // first run downloads ~10 MB of Pyodide
const RUN_TIMEOUT_MS = 15_000;

export class PythonRunner {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus; // 'idle' | 'loading' | 'running' | 'failed'
    this.worker = null;
    this.ready = false;
    this.queue = Promise.resolve();
    this.nextId = 1;
  }

  start() {
    if (this.worker) return;
    this.ready = false;
    this.onStatus('loading');
    this.worker = new Worker('/js/python-worker.js');
    this.worker.addEventListener('message', ({ data }) => {
      if (data.type === 'ready') {
        this.ready = true;
        this.onStatus('idle');
      } else if (data.type === 'failed') {
        this.onStatus('failed', data.error);
      }
    });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  /** Run one cell. Always resolves with a grid_runtime result object. */
  run(code, values) {
    const job = this.queue.then(() => this.#runNow(code, values));
    this.queue = job.catch(() => {});
    return job;
  }

  #runNow(code, values) {
    this.start();
    const worker = this.worker;
    const id = this.nextId++;
    const timeoutMs = this.ready ? RUN_TIMEOUT_MS : LOAD_TIMEOUT_MS;
    this.onStatus(this.ready ? 'running' : 'loading');
    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        if (this.worker === worker) this.onStatus(this.ready ? 'idle' : 'failed');
        resolve(result);
      };
      const onMessage = ({ data }) => {
        if (data.id === id) done(data.result);
        else if (data.type === 'failed') done(failure(`Python failed to load: ${data.error}`));
      };
      // A stuck cell (while True: ...) can only be stopped by killing the worker
      const timer = setTimeout(() => {
        this.stop();
        this.onStatus('idle');
        done(failure(`Timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      worker.addEventListener('message', onMessage);
      worker.postMessage({ id, code, values });
    });
  }
}

function failure(message) {
  return { value: { error: '#PYTHON!', message }, stdout: '', reads: [], error: message };
}
