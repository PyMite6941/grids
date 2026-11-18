// Web Worker hosting Pyodide (CPython compiled to WebAssembly).
// Runs in its own thread so a slow or infinite cell can't freeze the page —
// the main thread just terminates this worker on timeout.
//
// in : {id, code, values}      out: {id, result}  (result = grid_runtime.run_cell output)
// out: {type: 'ready'} | {type: 'failed', error}

/* global loadPyodide, importScripts */
const PYODIDE_VERSION = '0.27.2';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let runtime = null;

const ready = (async () => {
  importScripts(`${INDEX_URL}pyodide.js`);
  const pyodide = await loadPyodide({ indexURL: INDEX_URL });
  const src = await (await fetch('/shared/python/grid_runtime.py')).text();
  pyodide.FS.writeFile('/home/pyodide/grid_runtime.py', src);
  pyodide.runPython('import sys; sys.path.insert(0, "/home/pyodide"); import grid_runtime');
  runtime = { pyodide, run: pyodide.globals.get('grid_runtime').run_cell_json };
  self.postMessage({ type: 'ready' });
})().catch((e) => {
  self.postMessage({ type: 'failed', error: String(e?.message ?? e) });
  throw e;
});

self.onmessage = async ({ data }) => {
  const { id, code, values } = data;
  try {
    await ready;
    // Fetch any packages the cell imports (numpy, pandas...). df() needs pandas implicitly.
    await runtime.pyodide.loadPackagesFromImports(/\bdf\s*\(/.test(code) ? `import pandas\n${code}` : code);
    const out = runtime.run(JSON.stringify({ code, values }));
    self.postMessage({ id, result: JSON.parse(out) });
  } catch (e) {
    const message = String(e?.message ?? e);
    self.postMessage({ id, result: { value: { error: '#PYTHON!', message }, stdout: '', reads: [], error: message } });
  }
};
