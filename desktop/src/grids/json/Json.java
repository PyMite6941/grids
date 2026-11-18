package grids.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON reader/writer so the desktop app has no dependencies.
 * Objects -> LinkedHashMap, arrays -> ArrayList, numbers -> Double, plus String/Boolean/null.
 */
public final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    public static Object parse(String text) {
        Json p = new Json(text);
        p.ws();
        Object v = p.value(0);
        p.ws();
        if (p.i != p.s.length()) throw p.error("Trailing characters");
        return v;
    }

    private IllegalArgumentException error(String msg) {
        return new IllegalArgumentException(msg + " at position " + i);
    }

    private void ws() {
        while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) i++;
    }

    private Object value(int depth) {
        if (depth > 200) throw error("Nesting too deep");
        if (i >= s.length()) throw error("Unexpected end");
        char c = s.charAt(i);
        switch (c) {
            case '{': {
                i++;
                Map<String, Object> m = new LinkedHashMap<>();
                ws();
                if (peek('}')) return m;
                while (true) {
                    ws();
                    if (s.charAt(i) != '"') throw error("Expected key");
                    String k = string();
                    ws();
                    expect(':');
                    ws();
                    m.put(k, value(depth + 1));
                    ws();
                    if (peek('}')) return m;
                    expect(',');
                }
            }
            case '[': {
                i++;
                List<Object> l = new ArrayList<>();
                ws();
                if (peek(']')) return l;
                while (true) {
                    ws();
                    l.add(value(depth + 1));
                    ws();
                    if (peek(']')) return l;
                    expect(',');
                }
            }
            case '"':
                return string();
            case 't':
                return literal("true", Boolean.TRUE);
            case 'f':
                return literal("false", Boolean.FALSE);
            case 'n':
                return literal("null", null);
            default:
                return number();
        }
    }

    private boolean peek(char c) {
        if (i < s.length() && s.charAt(i) == c) {
            i++;
            return true;
        }
        return false;
    }

    private void expect(char c) {
        if (!peek(c)) throw error("Expected '" + c + "'");
    }

    private Object literal(String word, Object v) {
        if (!s.startsWith(word, i)) throw error("Bad literal");
        i += word.length();
        return v;
    }

    private Double number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        try {
            return Double.parseDouble(s.substring(start, i));
        } catch (NumberFormatException e) {
            throw error("Bad number");
        }
    }

    private String string() {
        expect('"');
        StringBuilder sb = new StringBuilder();
        while (true) {
            if (i >= s.length()) throw error("Unterminated string");
            char c = s.charAt(i++);
            if (c == '"') return sb.toString();
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            char e = s.charAt(i++);
            switch (e) {
                case 'n' -> sb.append('\n');
                case 't' -> sb.append('\t');
                case 'r' -> sb.append('\r');
                case 'b' -> sb.append('\b');
                case 'f' -> sb.append('\f');
                case 'u' -> {
                    sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    i += 4;
                }
                default -> sb.append(e); // \" \\ \/
            }
        }
    }

    // ---------- writing ----------

    public static String write(Object v) {
        StringBuilder sb = new StringBuilder();
        write(sb, v, -1, 0);
        return sb.toString();
    }

    public static String pretty(Object v) {
        StringBuilder sb = new StringBuilder();
        write(sb, v, 2, 0);
        return sb.toString();
    }

    private static void nl(StringBuilder sb, int indent, int level) {
        if (indent < 0) return;
        sb.append('\n').append(" ".repeat(indent * level));
    }

    private static void write(StringBuilder sb, Object v, int indent, int level) {
        if (v == null) sb.append("null");
        else if (v instanceof String str) quote(sb, str);
        else if (v instanceof Boolean b) sb.append(b);
        else if (v instanceof Number n) {
            double d = n.doubleValue();
            if (!Double.isFinite(d)) sb.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
            else sb.append(d);
        } else if (v instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                nl(sb, indent, level + 1);
                quote(sb, String.valueOf(e.getKey()));
                sb.append(indent < 0 ? ":" : ": ");
                write(sb, e.getValue(), indent, level + 1);
            }
            if (!m.isEmpty()) nl(sb, indent, level);
            sb.append('}');
        } else if (v instanceof List<?> l) {
            sb.append('[');
            for (int k = 0; k < l.size(); k++) {
                if (k > 0) sb.append(',');
                nl(sb, indent, level + 1);
                write(sb, l.get(k), indent, level + 1);
            }
            if (!l.isEmpty()) nl(sb, indent, level);
            sb.append(']');
        } else quote(sb, v.toString());
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append('"');
    }
}
