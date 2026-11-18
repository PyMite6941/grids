package grids.engine;

import static grids.engine.Values.*;

import grids.engine.Parser.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Whole-sheet evaluation: (inputs, python results) -> values.
 * The JavaScript twin is web/public/engine/evaluator.js — keep the algorithm identical
 * (memoised recursion, #CIRC! on cycles, row-major spill placement, repeat passes
 * until the spill map is stable).
 */
public final class Evaluator {
    private static final Pattern PY_PREFIX = Pattern.compile("^=py[ \\t\\r\\n]", Pattern.CASE_INSENSITIVE);
    private static final int MAX_PASSES = 8;

    public sealed interface Cell permits Literal, Formula, Python {}
    public record Literal(Object value) implements Cell {}
    public record Formula(Node ast, GridError error) implements Cell {}
    public record Python(String code) implements Cell {}

    /** Result: values for every non-empty cell incl. spill targets; spills = target -> anchor. */
    public record Result(Map<String, Object> values, Map<String, String> spills) {}

    private record Spilled(String anchor, Object value) {}

    private record State(Map<String, Object> memo, Map<String, Spilled> spill, Set<String> blocked) {}

    private static final Map<String, Cell> PARSE_CACHE = new HashMap<>();

    private Evaluator() {}

    public static boolean isPythonInput(String input) {
        return input != null && PY_PREFIX.matcher(input).lookingAt();
    }

    public static String pythonCode(String input) {
        return input.substring(3);
    }

    public static Cell classify(String input) {
        if (input == null || input.isEmpty()) return null;
        if (isPythonInput(input)) return new Python(pythonCode(input));
        if (input.startsWith("=")) {
            synchronized (PARSE_CACHE) {
                Cell c = PARSE_CACHE.get(input);
                if (c == null) {
                    try {
                        c = new Formula(Parser.parse(input.substring(1)), null);
                    } catch (Parser.ParseError e) {
                        c = new Formula(null, err("#ERROR!", e.getMessage()));
                    }
                    if (PARSE_CACHE.size() > 5000) PARSE_CACHE.clear();
                    PARSE_CACHE.put(input, c);
                }
                return c;
            }
        }
        if (input.startsWith("'")) return new Literal(input.substring(1));
        Double n = parseNumber(input);
        if (n != null) return new Literal(n);
        String u = input.trim().toUpperCase(java.util.Locale.ROOT);
        if (u.equals("TRUE") || u.equals("FALSE")) return new Literal(u.equals("TRUE"));
        return new Literal(input);
    }

    /** JSON-ish value (from Python / fixtures) -> engine value. Lists become 2-D arrays. */
    @SuppressWarnings("unchecked")
    public static Object fromPlain(Object v) {
        if (v instanceof List<?> list) {
            Object[][] out = new Object[list.size()][];
            for (int i = 0; i < list.size(); i++) {
                Object row = list.get(i);
                if (row instanceof List<?> r) {
                    out[i] = new Object[r.size()];
                    for (int j = 0; j < r.size(); j++) out[i][j] = fromPlain(r.get(j));
                } else out[i] = new Object[] {fromPlain(row)};
            }
            return out;
        }
        if (v instanceof Map<?, ?> m && m.get("error") instanceof String code) {
            Object msg = m.get("message");
            return err(code, msg == null ? "" : msg.toString());
        }
        if (v instanceof Number num) return Values.num(num.doubleValue());
        if (v == null || v instanceof String || v instanceof Boolean) return v;
        return v.toString();
    }

    private static Object normaliseArray(Object v) {
        if (!(v instanceof Object[][] g)) return v;
        if (g.length == 0) return null;
        int width = 0;
        for (Object[] r : g) width = Math.max(width, r.length);
        if (width == 0) return null;
        Object[][] out = new Object[g.length][width];
        for (int i = 0; i < g.length; i++) System.arraycopy(g[i], 0, out[i], 0, g[i].length);
        return out.length == 1 && width == 1 ? out[0][0] : out;
    }

    public static Result evaluate(Map<String, String> cells, Map<String, Object> python) {
        Map<String, Cell> classified = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : cells.entrySet()) {
            Cell c = classify(e.getValue());
            if (c != null) classified.put(e.getKey(), c);
        }
        State prev = new State(Map.of(), new HashMap<>(), new HashSet<>());
        State res = null;
        for (int pass = 0; pass < MAX_PASSES; pass++) {
            res = new Pass(classified, python == null ? Map.of() : python, prev).run();
            if (sameState(res, prev)) break;
            prev = res;
        }
        Map<String, Object> values = new LinkedHashMap<>(res.memo());
        Map<String, String> spills = new LinkedHashMap<>();
        for (Map.Entry<String, Spilled> e : res.spill().entrySet()) {
            values.put(e.getKey(), e.getValue().value());
            spills.put(e.getKey(), e.getValue().anchor());
        }
        return new Result(values, spills);
    }

    private static boolean sameValue(Object a, Object b) {
        if (a instanceof GridError x || b instanceof GridError) {
            return a instanceof GridError ea && b instanceof GridError eb && ea.code().equals(eb.code());
        }
        return Objects.equals(a, b);
    }

    private static boolean sameState(State a, State b) {
        if (a.spill().size() != b.spill().size() || !a.blocked().equals(b.blocked())) return false;
        for (Map.Entry<String, Spilled> e : a.spill().entrySet()) {
            Spilled o = b.spill().get(e.getKey());
            if (o == null || !o.anchor().equals(e.getValue().anchor()) || !sameValue(o.value(), e.getValue().value())) return false;
        }
        return true;
    }

    /** One evaluation pass. */
    private static final class Pass {
        private final Map<String, Cell> classified;
        private final Map<String, Object> python;
        private final State prev;
        private final Map<String, Object> memo = new HashMap<>();
        private final Set<String> visiting = new HashSet<>();
        private final Map<String, Object[][]> arrays = new HashMap<>();

        Pass(Map<String, Cell> classified, Map<String, Object> python, State prev) {
            this.classified = classified;
            this.python = python;
            this.prev = prev;
        }

        State run() {
            for (String k : classified.keySet()) cellValue(k);
            Map<String, Spilled> spill = new LinkedHashMap<>();
            Set<String> blocked = new HashSet<>();
            List<String> anchors = new ArrayList<>(arrays.keySet());
            anchors.sort(Refs::rowMajor);
            for (String anchor : anchors) {
                Object[][] g = arrays.get(anchor);
                Refs.Ref a = Refs.parseRef(anchor);
                List<Object[]> targets = new ArrayList<>();
                boolean ok = a.row() + g.length <= Refs.MAX_ROWS && a.col() + g[0].length <= Refs.MAX_COLS;
                outer:
                for (int i = 0; ok && i < g.length; i++) {
                    for (int j = 0; j < g[i].length; j++) {
                        if (i == 0 && j == 0) continue;
                        String t = Refs.key(a.col() + j, a.row() + i);
                        if (classified.containsKey(t) || spill.containsKey(t)) {
                            ok = false;
                            break outer;
                        }
                        targets.add(new Object[] {t, g[i][j]});
                    }
                }
                if (!ok) {
                    blocked.add(anchor);
                    memo.put(anchor, err("#SPILL!", "Spill range is not empty"));
                    continue;
                }
                memo.put(anchor, g[0][0]);
                for (Object[] t : targets) spill.put((String) t[0], new Spilled(anchor, t[1]));
            }
            return new State(memo, spill, blocked);
        }

        Object cellValue(String k) {
            if (memo.containsKey(k)) return memo.get(k);
            Cell c = classified.get(k);
            if (c == null) {
                Spilled s = prev.spill().get(k);
                return s == null ? null : s.value();
            }
            if (visiting.contains(k)) return err("#CIRC!", "Circular reference");
            visiting.add(k);
            Object v = normaliseArray(compute(c, k));
            visiting.remove(k);
            if (v instanceof Object[][] g) {
                arrays.put(k, g);
                v = prev.blocked().contains(k) ? err("#SPILL!", "Spill range is not empty") : g[0][0];
            }
            memo.put(k, v);
            return v;
        }

        Object compute(Cell c, String k) {
            if (c instanceof Literal l) return l.value();
            if (c instanceof Python) {
                return python.containsKey(k) ? python.get(k) : err("#BUSY!", "Python has not run for this cell yet");
            }
            Formula f = (Formula) c;
            return f.error() != null ? f.error() : ev(f.ast());
        }

        Object[][] range(RangeNode n) {
            Object[][] out = new Object[n.r2() - n.r1() + 1][n.c2() - n.c1() + 1];
            for (int r = n.r1(); r <= n.r2(); r++)
                for (int c = n.c1(); c <= n.c2(); c++) out[r - n.r1()][c - n.c1()] = cellValue(Refs.key(c, r));
            return out;
        }

        Object ev(Node n) {
            return switch (n) {
                case Num x -> x.v();
                case Str x -> x.v();
                case Bool x -> x.v();
                case RefNode x -> cellValue(Refs.key(x.col(), x.row()));
                case RangeNode x -> range(x);
                case Neg x -> {
                    Object v = toNumber(scalar(ev(x.e())));
                    yield v instanceof GridError ? v : (Object) (-(Double) v);
                }
                case Pct x -> {
                    Object v = toNumber(scalar(ev(x.e())));
                    yield v instanceof GridError ? v : (Object) ((Double) v / 100);
                }
                case Call x -> {
                    var fn = Functions.ALL.get(x.name());
                    if (fn == null) yield err("#NAME?", "Unknown function " + x.name());
                    List<Object> args = new ArrayList<>();
                    for (Node a : x.args()) args.add(a instanceof RefNode ? new Object[][] {{ev(a)}} : ev(a));
                    yield fn.apply(args);
                }
                case Bin x -> binary(x.op(), scalar(ev(x.l())), scalar(ev(x.r())));
            };
        }

        Object binary(String op, Object a, Object b) {
            if (a instanceof GridError) return a;
            if (b instanceof GridError) return b;
            if (op.equals("&")) return (String) toText(a) + toText(b);
            switch (op) {
                case "=": return compare(a, b) == 0;
                case "<>": return compare(a, b) != 0;
                case "<": return compare(a, b) < 0;
                case ">": return compare(a, b) > 0;
                case "<=": return compare(a, b) <= 0;
                case ">=": return compare(a, b) >= 0;
                default: break;
            }
            Object x = toNumber(a);
            if (x instanceof GridError) return x;
            Object y = toNumber(b);
            if (y instanceof GridError) return y;
            double dx = (Double) x;
            double dy = (Double) y;
            return switch (op) {
                case "+" -> num(dx + dy);
                case "-" -> num(dx - dy);
                case "*" -> num(dx * dy);
                case "/" -> dy == 0 ? err("#DIV/0!") : num(dx / dy);
                case "^" -> num(Math.pow(dx, dy));
                default -> throw new IllegalStateException("unknown operator " + op);
            };
        }
    }
}
