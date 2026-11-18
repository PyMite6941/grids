package grids.engine;

import java.math.BigDecimal;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Value model. Scalars are Double | String | Boolean | null (empty) | GridError.
 * Arrays are Object[][] (rows). Mirrors web/public/engine/values.js.
 */
public final class Values {
    private static final Pattern NUMERIC = Pattern.compile("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$");

    private Values() {}

    public static GridError err(String code) {
        return new GridError(code);
    }

    public static GridError err(String code, String message) {
        return new GridError(code, message);
    }

    public static boolean isErr(Object v) {
        return v instanceof GridError;
    }

    public static boolean isArr(Object v) {
        return v instanceof Object[][];
    }

    /** Numeric text ("42", " 1e3 ", "50%") -> Double; null if not numeric. */
    public static Double parseNumber(String text) {
        String s = text.trim();
        if (NUMERIC.matcher(s).matches()) return Double.parseDouble(s);
        if (s.endsWith("%")) {
            String body = s.substring(0, s.length() - 1).trim();
            if (NUMERIC.matcher(body).matches()) return Double.parseDouble(body) / 100;
        }
        return null;
    }

    /** NaN / Infinity never leak into the sheet. */
    public static Object num(double d) {
        return Double.isFinite(d) ? (Object) d : err("#NUM!");
    }

    public static Object toNumber(Object v) {
        if (v instanceof GridError) return v;
        if (v == null) return 0.0;
        if (v instanceof Double) return v;
        if (v instanceof Boolean b) return b ? 1.0 : 0.0;
        if (v instanceof String s) {
            Double n = s.trim().isEmpty() ? null : parseNumber(s);
            return n == null ? err("#VALUE!") : n;
        }
        return err("#VALUE!");
    }

    public static Object toBool(Object v) {
        if (v instanceof GridError) return v;
        if (v == null) return false;
        if (v instanceof Boolean) return v;
        if (v instanceof Double d) return d != 0;
        if (v instanceof String s) {
            String u = s.trim().toUpperCase(Locale.ROOT);
            if (u.equals("TRUE")) return true;
            if (u.equals("FALSE")) return false;
        }
        return err("#VALUE!");
    }

    /** Same text as JavaScript's String(n): 3, 0.5, 0.30000000000000004, 1e-7, 1e+21. */
    public static String numberToText(double d) {
        if (d == 0) return "0";
        double a = Math.abs(d);
        if (d == Math.rint(d) && a < 1e21) return new BigDecimal(d).toPlainString();
        BigDecimal bd = new BigDecimal(Double.toString(d)).stripTrailingZeros(); // shortest repr (JDK 19+)
        if (a >= 1e-6 && a < 1e21) return bd.toPlainString();
        String digits = bd.unscaledValue().abs().toString();
        int exp = digits.length() - 1 - bd.scale();
        String mant = digits.length() > 1 ? digits.charAt(0) + "." + digits.substring(1) : digits;
        return (d < 0 ? "-" : "") + mant + "e" + (exp >= 0 ? "+" : "-") + Math.abs(exp);
    }

    public static Object toText(Object v) {
        if (v instanceof GridError) return v;
        if (v == null) return "";
        if (v instanceof Boolean b) return b ? "TRUE" : "FALSE";
        if (v instanceof Double d) return numberToText(d);
        return String.valueOf(v);
    }

    private static int rank(Object v) {
        if (v instanceof Double) return 0;
        if (v instanceof String) return 1;
        return 2; // Boolean
    }

    /** Three-way compare for = < > and SORT. Text compares case-insensitively. */
    public static int compare(Object a, Object b) {
        if (a == null && b == null) return 0;
        if (a == null) a = b instanceof Double ? (Object) 0.0 : b instanceof String ? "" : false;
        if (b == null) b = a instanceof Double ? (Object) 0.0 : a instanceof String ? "" : false;
        int ta = rank(a);
        int tb = rank(b);
        if (ta != tb) return ta < tb ? -1 : 1;
        if (a instanceof String x) {
            int c = x.toLowerCase(Locale.ROOT).compareTo(((String) b).toLowerCase(Locale.ROOT));
            return Integer.signum(c);
        }
        if (a instanceof Boolean x) return x.equals(b) ? 0 : x ? 1 : -1;
        double x = (Double) a;
        double y = (Double) b;
        return x < y ? -1 : x > y ? 1 : 0;
    }

    /** 1x1 arrays collapse; bigger arrays are not allowed in a scalar position. */
    public static Object scalar(Object v) {
        if (!(v instanceof Object[][] g)) return v;
        if (g.length == 1 && g[0].length == 1) return g[0][0];
        return err("#VALUE!", "A range was used where a single value was expected");
    }
}
