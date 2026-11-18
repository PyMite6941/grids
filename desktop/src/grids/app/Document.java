package grids.app;

import grids.ai.AiClient;
import grids.engine.Evaluator;
import grids.engine.Format;
import grids.engine.GridError;
import grids.engine.Refs;
import grids.json.Json;
import grids.model.CellFormat;
import grids.model.Workbook;
import grids.python.PythonBridge;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * Desktop app state: workbook, computed values, undo/redo, Python pump and AI actions.
 * No Swing in here — the UI passes `ui` (SwingUtilities::invokeLater) and listens via
 * onChange. Same behaviour as web/public/js/app.js.
 *
 * Threading: every method must be called on the UI thread. Python runs on a single
 * worker thread; results are posted back through `ui`.
 */
public final class Document {
    private static final int MAX_UNDO = 100;
    private static final int MAX_PY_ROUNDS = 25;

    public final Workbook wb = new Workbook();
    public Map<String, Object> values = Map.of();
    public Map<String, String> spills = Map.of();
    public java.nio.file.Path file; // where it was opened from / saved to
    public boolean dirty = false;

    private final Map<String, Object> pyResults = new LinkedHashMap<>();
    private final Map<String, PyMeta> pyMeta = new LinkedHashMap<>();
    private boolean trusted = true;
    private boolean pumping = false;
    private boolean pumpAgain = false;
    private int generation = 0; // bumps when the workbook is replaced, so stale Python results are dropped

    private final Deque<Workbook> undo = new ArrayDeque<>();
    private final Deque<Workbook> redo = new ArrayDeque<>();

    private final Consumer<Runnable> ui;
    private final ExecutorService pyThread = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "python-runner");
        t.setDaemon(true);
        return t;
    });
    private final PythonBridge python = new PythonBridge();

    public Runnable onChange = () -> {};
    public Consumer<String> onPyStatus = s -> {};

    public record PyMeta(String code, Map<String, Object> reads, String stdout, String error) {}

    public Document(Consumer<Runnable> ui) {
        this.ui = ui;
        recalc();
    }

    // ---------- queries ----------

    public Object value(String key) {
        return values.get(key);
    }

    public String input(String key) {
        return wb.cells.getOrDefault(key, "");
    }

    public CellFormat format(String key) {
        return wb.formats.getOrDefault(key, CellFormat.EMPTY);
    }

    public String display(String key) {
        CellFormat f = wb.formats.get(key);
        return Format.value(values.get(key), f == null ? null : f.numFmt());
    }

    public boolean isPython(String key) {
        return Evaluator.isPythonInput(wb.cells.get(key));
    }

    public boolean isTrusted() {
        return trusted;
    }

    public boolean hasPython() {
        return wb.cells.values().stream().anyMatch(Evaluator::isPythonInput);
    }

    public PyMeta pyMeta(String key) {
        return pyMeta.get(key);
    }

    /** Largest used row/col (incl. spills), for sizing the table. */
    public int[] extent() {
        int maxR = -1, maxC = -1;
        for (String k : values.keySet()) {
            Refs.Ref r = Refs.parseRef(k);
            maxR = Math.max(maxR, r.row());
            maxC = Math.max(maxC, r.col());
        }
        return new int[] {maxR, maxC};
    }

    // ---------- mutations ----------

    /** Run fn as one undo step. */
    public void change(Consumer<Workbook> fn) {
        Workbook before = wb.copy();
        fn.accept(wb);
        undo.push(before);
        if (undo.size() > MAX_UNDO) undo.removeLast();
        redo.clear();
        dirty = true;
        recalc();
    }

    public boolean canUndo() {
        return !undo.isEmpty();
    }

    public boolean canRedo() {
        return !redo.isEmpty();
    }

    public void undo() {
        if (undo.isEmpty()) return;
        redo.push(wb.copy());
        wb.restore(undo.pop());
        dirty = true;
        recalc();
    }

    public void redo() {
        if (redo.isEmpty()) return;
        undo.push(wb.copy());
        wb.restore(redo.pop());
        dirty = true;
        recalc();
    }

    public void setInput(String key, String input) {
        if (Objects.equals(input(key), input == null ? "" : input)) return;
        change(w -> w.setInput(key, input));
    }

    public void formatRange(Refs.Range r, Map<String, Object> patch) {
        change(w -> {
            for (int row = r.r1(); row <= r.r2(); row++)
                for (int c = r.c1(); c <= r.c2(); c++) {
                    String k = Refs.key(c, row);
                    CellFormat f = w.formats.getOrDefault(k, CellFormat.EMPTY).merge(patch);
                    if (f.isEmpty()) w.formats.remove(k);
                    else w.formats.put(k, f);
                }
        });
    }

    /** Replace the whole workbook (New / Open). Opened files start untrusted: Python stays off. */
    public void replace(Workbook next, java.nio.file.Path from, boolean trust) {
        wb.restore(next);
        file = from;
        trusted = trust;
        dirty = false;
        undo.clear();
        redo.clear();
        pyResults.clear();
        pyMeta.clear();
        generation++;
        recalc();
    }

    /**
     * Apply AI tool calls as one undo step. The model's output is untrusted input, so each
     * call is validated; skipped calls are returned as human-readable problems.
     */
    @SuppressWarnings("unchecked")
    public List<String> applyActions(List<AiClient.Action> actions) {
        List<String> problems = new ArrayList<>();
        change(w -> {
            for (AiClient.Action a : actions) {
                Map<String, Object> args = a.args();
                switch (a.name()) {
                    case "set_cells" -> {
                        if (!(args.get("cells") instanceof List<?> cells)) {
                            problems.add("set_cells: no cells");
                            break;
                        }
                        for (Object o : cells) {
                            if (o instanceof Map<?, ?> c && c.get("ref") instanceof String ref && Refs.normKey(ref) != null && c.get("input") instanceof String in) {
                                w.setInput(Refs.normKey(ref), in);
                            } else problems.add("set_cells: bad cell " + Json.write(o));
                        }
                    }
                    case "clear_range" -> {
                        Refs.Range r = args.get("range") instanceof String s ? Refs.parseRange(s) : null;
                        if (r == null || r.size() > Refs.MAX_RANGE_CELLS) {
                            problems.add("clear_range: bad range " + args.get("range"));
                            break;
                        }
                        boolean formats = Boolean.TRUE.equals(args.get("formats"));
                        for (int row = r.r1(); row <= r.r2(); row++)
                            for (int c = r.c1(); c <= r.c2(); c++) {
                                w.cells.remove(Refs.key(c, row));
                                if (formats) w.formats.remove(Refs.key(c, row));
                            }
                    }
                    case "format_range" -> {
                        Refs.Range r = args.get("range") instanceof String s ? Refs.parseRange(s) : null;
                        if (r == null || r.size() > 50_000) {
                            problems.add("format_range: bad range " + args.get("range"));
                            break;
                        }
                        Map<String, Object> patch = new LinkedHashMap<>(args);
                        patch.remove("range");
                        for (int row = r.r1(); row <= r.r2(); row++)
                            for (int c = r.c1(); c <= r.c2(); c++) {
                                String k = Refs.key(c, row);
                                CellFormat f = w.formats.getOrDefault(k, CellFormat.EMPTY).merge(patch);
                                if (f.isEmpty()) w.formats.remove(k);
                                else w.formats.put(k, f);
                            }
                    }
                    case "set_column_width" -> {
                        String col = String.valueOf(args.get("column")).toUpperCase();
                        Integer width = Workbook.clampWidth(args.get("width"));
                        if (!col.matches("[A-Z]{1,3}") || width == null) problems.add("set_column_width: bad column/width");
                        else w.colWidths.put(col, width);
                    }
                    case "set_title" -> {
                        if (args.get("title") instanceof String t && !t.isBlank()) w.title = t.strip().substring(0, Math.min(200, t.strip().length()));
                    }
                    default -> problems.add("unknown action " + a.name());
                }
            }
        });
        return problems;
    }

    /** Snapshot for the AI: rows in row-major order, input + displayed value. */
    public Map<String, String[]> aiSnapshot() {
        Map<String, String[]> out = new LinkedHashMap<>();
        wb.cells.keySet().stream().sorted(Refs::rowMajor).forEach(k -> out.put(k, new String[] {wb.cells.get(k), display(k)}));
        return out;
    }

    // ---------- recalculation + Python ----------

    public void recalc() {
        pyResults.keySet().removeIf(k -> !isPython(k));
        pyMeta.keySet().removeIf(k -> !isPython(k));
        Evaluator.Result r = Evaluator.evaluate(wb.cells, pyResults);
        values = r.values();
        spills = r.spills();
        onChange.run();
        if (trusted && hasPython()) pump(false);
    }

    /** JSON-ish form of a value, for Python and for change detection. */
    static Object plain(Object v) {
        if (v instanceof GridError e) return Map.of("error", e.code(), "message", e.message());
        return v;
    }

    private String nextStale() {
        List<String> stale = new ArrayList<>();
        for (Map.Entry<String, String> e : wb.cells.entrySet()) {
            if (!Evaluator.isPythonInput(e.getValue())) continue;
            PyMeta m = pyMeta.get(e.getKey());
            String code = Evaluator.pythonCode(e.getValue());
            if (m == null || !m.code().equals(code)) {
                stale.add(e.getKey());
                continue;
            }
            for (Map.Entry<String, Object> read : m.reads().entrySet()) {
                if (!Json.write(plain(values.get(read.getKey()))).equals(Json.write(read.getValue()))) {
                    stale.add(e.getKey());
                    break;
                }
            }
        }
        stale.sort(Refs::rowMajor);
        return stale.isEmpty() ? null : stale.get(0);
    }

    /** Re-run Python cells until nothing is stale (bounded). Each run is one async hop. */
    private void pump(boolean force) {
        if (pumping) {
            pumpAgain = true;
            return;
        }
        if (force) pyMeta.clear();
        pumping = true;
        step(0, generation);
    }

    private void step(int round, int gen) {
        String k = round < MAX_PY_ROUNDS && trusted && gen == generation ? nextStale() : null;
        if (k == null) {
            pumping = false;
            onPyStatus.accept("ready");
            if (pumpAgain) {
                pumpAgain = false;
                pump(false);
            }
            return;
        }
        String input = wb.cells.get(k);
        String code = Evaluator.pythonCode(input);
        Map<String, Object> snapshot = new LinkedHashMap<>();
        values.forEach((ref, v) -> snapshot.put(ref, plain(v)));
        onPyStatus.accept("running " + k);
        pyThread.submit(() -> {
            PythonBridge.Result res = python.run(code, snapshot);
            ui.accept(() -> {
                if (gen == generation && input.equals(wb.cells.get(k))) {
                    pyResults.put(k, Evaluator.fromPlain(res.value()));
                    Map<String, Object> reads = new LinkedHashMap<>();
                    for (String r : res.reads()) reads.put(r, snapshot.get(r));
                    pyMeta.put(k, new PyMeta(code, reads, res.stdout(), res.error()));
                    Evaluator.Result r = Evaluator.evaluate(wb.cells, pyResults);
                    values = r.values();
                    spills = r.spills();
                    onChange.run();
                }
                step(round + 1, gen);
            });
        });
    }

    /** "Run Python" / "Enable Python for this workbook". */
    public void runAllPython() {
        trusted = true;
        Evaluator.Result r = Evaluator.evaluate(wb.cells, pyResults);
        values = r.values();
        spills = r.spills();
        onChange.run();
        pump(true);
    }

    public void close() {
        python.close();
        pyThread.shutdownNow();
    }
}
