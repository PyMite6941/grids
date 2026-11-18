package grids.engine;

import static grids.engine.Values.*;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;

/**
 * Built-in functions. Arguments arrive evaluated; every reference/range argument is an
 * Object[][] so aggregates can skip text found in ranges but coerce literal text.
 * Keep in step with web/public/engine/functions.js and shared/FORMULAS.md.
 */
public final class Functions {
    private static final int MAX_ARRAY_CELLS = 250_000;

    public static final Map<String, Function<List<Object>, Object>> ALL = new HashMap<>();

    private Functions() {}

    private static boolean arity(List<Object> a, int min, int max) {
        return a.size() >= min && a.size() <= max;
    }

    private static Object n(Object v) {
        return toNumber(scalar(v));
    }

    private static Object[][] grid(Object v) {
        return v instanceof Object[][] g ? g : new Object[][] {{v}};
    }

    private static List<Object> flat(List<Object> args) {
        List<Object> out = new ArrayList<>();
        for (Object a : args) {
            if (a instanceof Object[][] g) for (Object[] row : g) out.addAll(Arrays.asList(row));
            else out.add(a);
        }
        return out;
    }

    /** Numbers for SUM/AVERAGE/MIN/MAX, or the first error. */
    private static Object collectNumbers(List<Object> args) {
        List<Double> nums = new ArrayList<>();
        for (Object a : args) {
            if (a instanceof Object[][] g) {
                for (Object[] row : g)
                    for (Object v : row) {
                        if (v instanceof GridError) return v;
                        if (v instanceof Double d) nums.add(d);
                    }
            } else {
                if (a == null) continue;
                Object x = toNumber(a);
                if (x instanceof GridError) return x;
                nums.add((Double) x);
            }
        }
        return nums;
    }

    @SuppressWarnings("unchecked")
    private static Function<List<Object>, Object> aggregate(Function<List<Double>, Object> fn) {
        return args -> {
            if (args.isEmpty()) return err("#VALUE!");
            Object r = collectNumbers(args);
            return r instanceof GridError ? r : fn.apply((List<Double>) r);
        };
    }

    private static Object logical(List<Object> args, boolean isAnd) {
        if (args.isEmpty()) return err("#VALUE!");
        Boolean acc = null;
        for (Object a : args) {
            List<Object> items = new ArrayList<>();
            if (a instanceof Object[][] g) {
                for (Object[] row : g)
                    for (Object v : row)
                        if (v instanceof Boolean || v instanceof Double || v instanceof GridError) items.add(v);
            } else items.add(a);
            for (Object v : items) {
                Object b = toBool(v);
                if (b instanceof GridError) return b;
                acc = acc == null ? (Boolean) b : isAnd ? acc && (Boolean) b : acc || (Boolean) b;
            }
        }
        return acc == null ? err("#VALUE!") : acc;
    }

    /** Half away from zero on the shortest decimal form of x (2.345 -> 2.35), like the JS engine. */
    public static double roundHalfAway(double x, int digits) {
        BigDecimal bd = new BigDecimal(Double.toString(Math.abs(x))).setScale(digits, RoundingMode.HALF_UP);
        double r = bd.doubleValue();
        return x < 0 ? -r : r;
    }

    private static Function<List<Object>, Object> textFn(Function<String, Object> fn) {
        return args -> {
            if (!arity(args, 1, 1)) return err("#VALUE!");
            Object s = toText(scalar(args.get(0)));
            return s instanceof GridError ? s : fn.apply((String) s);
        };
    }

    private interface Take {
        String apply(String s, int k);
    }

    private static Function<List<Object>, Object> leftRight(Take take) {
        return args -> {
            if (!arity(args, 1, 2)) return err("#VALUE!");
            Object s = toText(scalar(args.get(0)));
            if (s instanceof GridError) return s;
            Object k = args.size() > 1 ? n(args.get(1)) : (Object) 1.0;
            if (k instanceof GridError) return k;
            double kd = (Double) k;
            if (kd < 0) return err("#VALUE!");
            return take.apply((String) s, (int) Math.floor(kd));
        };
    }

    private static Object unary(List<Object> args, Function<Double, Object> fn) {
        if (!arity(args, 1, 1)) return err("#VALUE!");
        Object x = n(args.get(0));
        return x instanceof GridError ? x : fn.apply((Double) x);
    }

    private static Object binary(List<Object> args, java.util.function.BiFunction<Double, Double, Object> fn) {
        if (!arity(args, 2, 2)) return err("#VALUE!");
        Object a = n(args.get(0));
        if (a instanceof GridError) return a;
        Object b = n(args.get(1));
        if (b instanceof GridError) return b;
        return fn.apply((Double) a, (Double) b);
    }

    static {
        ALL.put("SUM", aggregate(xs -> num(xs.stream().mapToDouble(Double::doubleValue).sum())));
        ALL.put("AVERAGE", aggregate(xs -> xs.isEmpty() ? err("#DIV/0!") : num(xs.stream().mapToDouble(Double::doubleValue).sum() / xs.size())));
        ALL.put("MIN", aggregate(xs -> xs.isEmpty() ? (Object) 0.0 : Collections.min(xs)));
        ALL.put("MAX", aggregate(xs -> xs.isEmpty() ? (Object) 0.0 : Collections.max(xs)));
        ALL.put("COUNT", args -> (double) flat(args).stream().filter(v -> v instanceof Double).count());
        ALL.put("COUNTA", args -> (double) flat(args).stream().filter(v -> v != null).count());

        ALL.put("IF", args -> {
            if (!arity(args, 2, 3)) return err("#VALUE!");
            Object c = toBool(scalar(args.get(0)));
            if (c instanceof GridError) return c;
            return (Boolean) c ? args.get(1) : args.size() > 2 ? args.get(2) : (Object) false;
        });
        ALL.put("IFERROR", args -> {
            if (!arity(args, 2, 2)) return err("#VALUE!");
            return args.get(0) instanceof GridError ? args.get(1) : args.get(0);
        });
        ALL.put("AND", args -> logical(args, true));
        ALL.put("OR", args -> logical(args, false));
        ALL.put("NOT", args -> {
            if (!arity(args, 1, 1)) return err("#VALUE!");
            Object b = toBool(scalar(args.get(0)));
            return b instanceof GridError ? b : !(Boolean) b;
        });

        ALL.put("ROUND", args -> {
            if (!arity(args, 1, 2)) return err("#VALUE!");
            Object x = n(args.get(0));
            if (x instanceof GridError) return x;
            Object d = args.size() > 1 ? n(args.get(1)) : (Object) 0.0;
            if (d instanceof GridError) return d;
            return num(roundHalfAway((Double) x, (int) (double) (Double) d));
        });
        ALL.put("ABS", args -> unary(args, Math::abs));
        ALL.put("SQRT", args -> unary(args, x -> x < 0 ? err("#NUM!") : (Object) Math.sqrt(x)));
        ALL.put("POWER", args -> binary(args, (a, b) -> num(Math.pow(a, b))));
        ALL.put("MOD", args -> binary(args, (a, b) -> b == 0 ? err("#DIV/0!") : num(a - b * Math.floor(a / b))));

        ALL.put("CONCAT", args -> {
            if (args.isEmpty()) return err("#VALUE!");
            StringBuilder sb = new StringBuilder();
            for (Object v : flat(args)) {
                Object t = toText(v);
                if (t instanceof GridError) return t;
                sb.append(t);
            }
            return sb.toString();
        });
        ALL.put("LEN", textFn(s -> (double) s.length()));
        ALL.put("UPPER", textFn(s -> s.toUpperCase(Locale.ROOT)));
        ALL.put("LOWER", textFn(s -> s.toLowerCase(Locale.ROOT)));
        // Excel TRIM only touches the space character, not tabs/newlines
        ALL.put("TRIM", textFn(s -> s.replaceAll("^ +| +$", "").replaceAll(" +", " ")));
        ALL.put("LEFT", leftRight((s, k) -> s.substring(0, Math.min(k, s.length()))));
        ALL.put("RIGHT", leftRight((s, k) -> k == 0 ? "" : s.substring(Math.max(0, s.length() - k))));

        ALL.put("SEQUENCE", args -> {
            if (!arity(args, 1, 4)) return err("#VALUE!");
            double[] v = new double[4];
            Object[] raw = {args.get(0), args.size() > 1 ? args.get(1) : 1.0, args.size() > 2 ? args.get(2) : 1.0, args.size() > 3 ? args.get(3) : 1.0};
            for (int i = 0; i < 4; i++) {
                Object x = n(raw[i]);
                if (x instanceof GridError) return x;
                v[i] = (Double) x;
            }
            long r = (long) v[0];
            long c = (long) v[1];
            if (r < 1 || c < 1) return err("#VALUE!");
            if (r * c > MAX_ARRAY_CELLS) return err("#NUM!");
            Object[][] out = new Object[(int) r][(int) c];
            for (int i = 0; i < r; i++)
                for (int j = 0; j < c; j++) out[i][j] = num(v[2] + (i * c + j) * v[3]);
            return out;
        });
        ALL.put("TRANSPOSE", args -> {
            if (!arity(args, 1, 1)) return err("#VALUE!");
            Object[][] g = grid(args.get(0));
            Object[][] out = new Object[g[0].length][g.length];
            for (int i = 0; i < g.length; i++)
                for (int j = 0; j < g[0].length; j++) out[j][i] = g[i][j];
            return out;
        });
        ALL.put("SORT", args -> {
            if (!arity(args, 1, 3)) return err("#VALUE!");
            Object[][] g = grid(args.get(0));
            Object col = args.size() > 1 ? n(args.get(1)) : (Object) 1.0;
            if (col instanceof GridError) return col;
            Object asc = args.size() > 2 ? toBool(scalar(args.get(2))) : (Object) true;
            if (asc instanceof GridError) return asc;
            int c = (int) (double) (Double) col - 1;
            if (c < 0 || c >= g[0].length) return err("#VALUE!");
            for (Object[] row : g) if (row[c] instanceof GridError) return row[c];
            List<Object[]> rows = new ArrayList<>(Arrays.asList(g));
            rows.sort((a, b) -> compare(a[c], b[c])); // stable, like JS
            if (!(Boolean) asc) Collections.reverse(rows); // reverse after a stable sort, same as the JS engine
            return rows.toArray(new Object[0][]);
        });
    }
}
