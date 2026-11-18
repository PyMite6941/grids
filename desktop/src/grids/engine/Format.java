package grids.engine;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.util.List;
import java.util.Locale;

/** Display formatting for the enumerated number formats in shared/FORMAT.md. Mirrors format.js. */
public final class Format {
    public static final List<String> NUM_FORMATS = List.of("general", "0", "0.00", "#,##0", "#,##0.00", "0%", "0.00%", "$#,##0.00");

    private Format() {}

    private static String fixed(double v, int digits, boolean grouping) {
        DecimalFormat f = new DecimalFormat(grouping ? "#,##0" : "0", DecimalFormatSymbols.getInstance(Locale.US));
        f.setMinimumFractionDigits(digits);
        f.setMaximumFractionDigits(digits);
        f.setRoundingMode(RoundingMode.HALF_UP);
        String s = f.format(v);
        return s.equals("-0") || s.matches("-0\\.0+") ? s.substring(1) : s;
    }

    /** Integers as-is, otherwise up to 10 significant digits. */
    public static String general(double n) {
        if (n == Math.rint(n) && Math.abs(n) < 1e15) return Values.numberToText(n);
        double r = new BigDecimal(Double.toString(n)).round(new MathContext(10, RoundingMode.HALF_UP)).doubleValue();
        return Values.numberToText(r);
    }

    public static String value(Object v, String numFmt) {
        if (v == null) return "";
        if (v instanceof GridError e) return e.code();
        if (v instanceof Boolean b) return b ? "TRUE" : "FALSE";
        if (!(v instanceof Double d)) return String.valueOf(v);
        return switch (numFmt == null ? "general" : numFmt) {
            case "0" -> fixed(d, 0, false);
            case "0.00" -> fixed(d, 2, false);
            case "#,##0" -> fixed(d, 0, true);
            case "#,##0.00" -> fixed(d, 2, true);
            case "0%" -> fixed(d * 100, 0, false) + "%";
            case "0.00%" -> fixed(d * 100, 2, false) + "%";
            case "$#,##0.00" -> (d < 0 ? "-$" : "$") + fixed(Math.abs(d), 2, true);
            default -> general(d);
        };
    }
}
