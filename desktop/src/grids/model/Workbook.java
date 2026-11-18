package grids.model;

import grids.engine.Refs;
import grids.json.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Workbook data + the .grid file format (shared/FORMAT.md). Everything read from a file is sanitised. */
public final class Workbook {
    public static final int MAX_INPUT_CHARS = 50_000;

    public String title = "Untitled";
    public final Map<String, String> cells = new LinkedHashMap<>();
    public final Map<String, CellFormat> formats = new LinkedHashMap<>();
    public final Map<String, Integer> colWidths = new LinkedHashMap<>();

    public Workbook copy() {
        Workbook w = new Workbook();
        w.title = title;
        w.cells.putAll(cells);
        w.formats.putAll(formats);
        w.colWidths.putAll(colWidths);
        return w;
    }

    public void restore(Workbook from) {
        title = from.title;
        cells.clear();
        cells.putAll(from.cells);
        formats.clear();
        formats.putAll(from.formats);
        colWidths.clear();
        colWidths.putAll(from.colWidths);
    }

    public void setInput(String key, String input) {
        if (input == null || input.isEmpty()) cells.remove(key);
        else cells.put(key, input.length() > MAX_INPUT_CHARS ? input.substring(0, MAX_INPUT_CHARS) : input);
    }

    public static Integer clampWidth(Object w) {
        if (!(w instanceof Number n) || !Double.isFinite(n.doubleValue())) return null;
        return (int) Math.max(40, Math.min(600, Math.round(n.doubleValue())));
    }

    public String toJson() {
        Map<String, Object> sheet = new LinkedHashMap<>();
        sheet.put("name", "Sheet1");
        sheet.put("cells", new TreeMap<String, Object>(Refs::rowMajor) {{ putAll(cells); }});
        Map<String, Object> f = new TreeMap<>(Refs::rowMajor);
        formats.forEach((k, v) -> f.put(k, v.toMap()));
        sheet.put("formats", f);
        sheet.put("colWidths", new LinkedHashMap<String, Object>(colWidths));
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("format", "grids");
        doc.put("version", 1);
        doc.put("title", title);
        doc.put("sheets", List.of(sheet));
        return Json.pretty(doc);
    }

    @SuppressWarnings("unchecked")
    public static Workbook fromJson(String text) {
        Object parsed = Json.parse(text);
        if (!(parsed instanceof Map<?, ?> doc) || !"grids".equals(doc.get("format"))) throw new IllegalArgumentException("Not a Grids file.");
        if (!(doc.get("version") instanceof Double v) || v != 1) throw new IllegalArgumentException("Unsupported Grids file version " + doc.get("version") + ".");
        if (!(doc.get("sheets") instanceof List<?> sheets) || sheets.isEmpty() || !(sheets.get(0) instanceof Map<?, ?> sheet)) {
            throw new IllegalArgumentException("The file has no sheets.");
        }
        Workbook w = new Workbook();
        w.title = doc.get("title") instanceof String t ? t.substring(0, Math.min(200, t.length())) : "Untitled";
        if (sheet.get("cells") instanceof Map<?, ?> cells) {
            cells.forEach((k, val) -> {
                String nk = Refs.normKey(String.valueOf(k));
                if (nk != null && val instanceof String s && !s.isEmpty()) w.setInput(nk, s);
            });
        }
        if (sheet.get("formats") instanceof Map<?, ?> formats) {
            formats.forEach((k, val) -> {
                String nk = Refs.normKey(String.valueOf(k));
                if (nk != null && val instanceof Map<?, ?> m) {
                    CellFormat f = CellFormat.fromMap((Map<String, Object>) m);
                    if (!f.isEmpty()) w.formats.put(nk, f);
                }
            });
        }
        if (sheet.get("colWidths") instanceof Map<?, ?> widths) {
            widths.forEach((k, val) -> {
                Integer cw = clampWidth(val);
                if (String.valueOf(k).matches("[A-Z]{1,3}") && cw != null) w.colWidths.put(String.valueOf(k), cw);
            });
        }
        return w;
    }

    // ---------- CSV ----------

    public static List<List<String>> parseCsv(String text) {
        List<List<String>> rows = new ArrayList<>();
        List<String> row = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (quoted) {
                if (ch == '"' && i + 1 < text.length() && text.charAt(i + 1) == '"') {
                    field.append('"');
                    i++;
                } else if (ch == '"') quoted = false;
                else field.append(ch);
            } else if (ch == '"') quoted = true;
            else if (ch == ',') {
                row.add(field.toString());
                field.setLength(0);
            } else if (ch == '\n' || ch == '\r') {
                if (ch == '\r' && i + 1 < text.length() && text.charAt(i + 1) == '\n') i++;
                row.add(field.toString());
                rows.add(row);
                row = new ArrayList<>();
                field.setLength(0);
            } else field.append(ch);
        }
        if (field.length() > 0 || !row.isEmpty()) {
            row.add(field.toString());
            rows.add(row);
        }
        return rows;
    }

    /** CSV -> workbook. Values starting with "=" import as text so a CSV can't smuggle in Python. */
    public static Workbook fromCsv(String title, String text) {
        Workbook w = new Workbook();
        w.title = title;
        List<List<String>> rows = parseCsv(text);
        for (int r = 0; r < rows.size(); r++)
            for (int c = 0; c < rows.get(r).size(); c++) {
                String v = rows.get(r).get(c);
                if (!v.isEmpty()) w.setInput(Refs.key(c, r), v.startsWith("=") ? "'" + v : v);
            }
        return w;
    }

    public static String toCsv(List<List<String>> rows) {
        StringBuilder sb = new StringBuilder();
        for (int r = 0; r < rows.size(); r++) {
            if (r > 0) sb.append("\r\n");
            List<String> row = rows.get(r);
            for (int c = 0; c < row.size(); c++) {
                if (c > 0) sb.append(',');
                String s = row.get(c);
                sb.append(s.matches("(?s).*[\",\r\n].*") ? "\"" + s.replace("\"", "\"\"") + "\"" : s);
            }
        }
        return sb.toString();
    }
}
