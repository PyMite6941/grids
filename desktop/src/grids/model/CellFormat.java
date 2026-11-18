package grids.model;

import grids.engine.Format;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Per-cell formatting (shared/FORMAT.md). Null fields mean "not set". Immutable. */
public record CellFormat(Boolean bold, Boolean italic, String align, String numFmt, String bg, String color) {
    private static final Pattern HEX = Pattern.compile("^#[0-9a-fA-F]{6}$");
    private static final Set<String> ALIGN = Set.of("left", "center", "right");

    public static final CellFormat EMPTY = new CellFormat(null, null, null, null, null, null);

    public boolean isEmpty() {
        return equals(EMPTY);
    }

    /** Merge a patch (from a file, the toolbar or the AI) with whitelisting; invalid values are dropped. */
    public CellFormat merge(Map<String, Object> patch) {
        Boolean b = bold, i = italic;
        String a = align, n = numFmt, bgc = bg, c = color;
        if (patch.containsKey("bold")) b = patch.get("bold") instanceof Boolean x && x ? true : null;
        if (patch.containsKey("italic")) i = patch.get("italic") instanceof Boolean x && x ? true : null;
        if (patch.containsKey("align")) a = patch.get("align") instanceof String s && ALIGN.contains(s) ? s : null;
        if (patch.containsKey("numFmt")) n = patch.get("numFmt") instanceof String s && Format.NUM_FORMATS.contains(s) && !s.equals("general") ? s : null;
        if (patch.containsKey("bg")) bgc = colour(patch.get("bg"), bgc);
        if (patch.containsKey("color")) c = colour(patch.get("color"), c);
        return new CellFormat(b, i, a, n, bgc, c);
    }

    /** Valid #rrggbb sets it, null/"" clears it, anything else leaves it alone. */
    private static String colour(Object v, String current) {
        if (v == null || "".equals(v)) return null;
        return v instanceof String s && HEX.matcher(s).matches() ? s.toLowerCase() : current;
    }

    public static CellFormat fromMap(Map<String, Object> m) {
        return EMPTY.merge(m);
    }

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        if (bold != null) m.put("bold", bold);
        if (italic != null) m.put("italic", italic);
        if (align != null) m.put("align", align);
        if (numFmt != null) m.put("numFmt", numFmt);
        if (bg != null) m.put("bg", bg);
        if (color != null) m.put("color", color);
        return m;
    }
}
