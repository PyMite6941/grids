package grids.engine;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A1-style addressing; columns and rows are 0-based internally. Mirrors web/public/engine/refs.js. */
public final class Refs {
    public static final int MAX_COLS = 18278; // ZZZ
    public static final int MAX_ROWS = 1_000_000;
    public static final int MAX_RANGE_CELLS = 250_000;

    private static final Pattern REF = Pattern.compile("^\\$?([A-Za-z]{1,3})\\$?([1-9]\\d{0,6})$");

    public record Ref(int col, int row) {}

    public record Range(int c1, int r1, int c2, int r2) {
        public long size() {
            return (long) (c2 - c1 + 1) * (r2 - r1 + 1);
        }
    }

    private Refs() {}

    public static int colToIndex(String letters) {
        int n = 0;
        for (char ch : letters.toUpperCase().toCharArray()) n = n * 26 + (ch - 'A' + 1);
        return n - 1;
    }

    public static String indexToCol(int i) {
        StringBuilder sb = new StringBuilder();
        for (int n = i + 1; n > 0; n = (n - 1) / 26) sb.insert(0, (char) ('A' + (n - 1) % 26));
        return sb.toString();
    }

    public static String key(int col, int row) {
        return indexToCol(col) + (row + 1);
    }

    /** "B12" / "$B$12" -> Ref(1, 11); null if invalid. */
    public static Ref parseRef(String text) {
        if (text == null) return null;
        Matcher m = REF.matcher(text.trim());
        if (!m.matches()) return null;
        int col = colToIndex(m.group(1));
        int row = Integer.parseInt(m.group(2)) - 1;
        if (col >= MAX_COLS || row >= MAX_ROWS) return null;
        return new Ref(col, row);
    }

    /** "A1:C3" or "A1" -> normalised Range; null if invalid. */
    public static Range parseRange(String text) {
        if (text == null) return null;
        String[] parts = text.split(":", -1);
        if (parts.length > 2) return null;
        Ref a = parseRef(parts[0]);
        Ref b = parts.length == 2 ? parseRef(parts[1]) : a;
        if (a == null || b == null) return null;
        return new Range(Math.min(a.col(), b.col()), Math.min(a.row(), b.row()), Math.max(a.col(), b.col()), Math.max(a.row(), b.row()));
    }

    /** "$b$3" -> "B3"; null if invalid. */
    public static String normKey(String text) {
        Ref r = parseRef(text);
        return r == null ? null : key(r.col(), r.row());
    }

    /** Row-major ordering of keys (row first, then column). */
    public static int rowMajor(String a, String b) {
        Ref ra = parseRef(a);
        Ref rb = parseRef(b);
        return ra.row() != rb.row() ? Integer.compare(ra.row(), rb.row()) : Integer.compare(ra.col(), rb.col());
    }
}
