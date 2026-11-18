import grids.engine.Evaluator;
import grids.engine.Format;
import grids.engine.GridError;
import grids.engine.Values;
import grids.json.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs shared/fixtures/formulas.json against the Java engine (web/test/engine.test.js runs
 * the same file against the JS engine). Plain main() so no JUnit download is needed.
 * Usage: java -cp build/classes:build/test EngineFixtures ../shared/fixtures/formulas.json
 */
public class EngineFixtures {
    static int failures = 0;

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        Path file = Path.of(args.length > 0 ? args[0] : "../shared/fixtures/formulas.json");
        Map<String, Object> doc = (Map<String, Object>) Json.parse(Files.readString(file));
        List<Object> cases = (List<Object>) doc.get("cases");
        for (Object o : cases) {
            Map<String, Object> c = (Map<String, Object>) o;
            String name = (String) c.get("name");
            Map<String, String> cells = new LinkedHashMap<>();
            ((Map<String, Object>) c.get("cells")).forEach((k, v) -> cells.put(k, (String) v));
            Map<String, Object> python = new LinkedHashMap<>();
            Map<String, Object> py = (Map<String, Object>) c.getOrDefault("python", Map.of());
            py.forEach((k, v) -> python.put(k, Evaluator.fromPlain(v)));
            Map<String, Object> values = Evaluator.evaluate(cells, python).values();
            int before = failures;
            ((Map<String, Object>) c.get("expect")).forEach((ref, expected) -> check(name + " " + ref, values.get(ref), expected));
            System.out.println((failures == before ? "ok   " : "FAIL ") + name);
        }
        selfChecks();
        System.out.println(failures == 0 ? "\nAll " + cases.size() + " fixture cases passed." : "\n" + failures + " check(s) failed.");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void check(String where, Object actual, Object expected) {
        boolean ok;
        if (expected == null) ok = actual == null;
        else if (expected instanceof Map<?, ?> m) ok = actual instanceof GridError e && e.code().equals(m.get("error"));
        else if (expected instanceof Double d) ok = actual instanceof Double a && Math.abs(a - d) < 1e-9;
        else ok = expected.equals(actual);
        if (!ok) {
            failures++;
            System.out.println("  " + where + ": expected " + Json.write(expected) + ", got " + actual);
        }
    }

    /** Text conversions that must match JavaScript's String(n). */
    static void selfChecks() {
        Object[][] cases = {
            {3.0, "3"}, {0.5, "0.5"}, {0.1 + 0.2, "0.30000000000000004"}, {-12.25, "-12.25"},
            {1e-7, "1e-7"}, {1.5e21, "1.5e+21"}, {123456789012.0, "123456789012"}, {-0.000001, "-0.000001"},
        };
        for (Object[] c : cases) {
            String got = Values.numberToText((Double) c[0]);
            if (!got.equals(c[1])) {
                failures++;
                System.out.println("  numberToText(" + c[0] + "): expected " + c[1] + ", got " + got);
            }
        }
        String[][] fmt = {{"1234.5", "$#,##0.00", "$1,234.50"}, {"0.256", "0.00%", "25.60%"}, {"-3", "$#,##0.00", "-$3.00"}, {"0.30000000000000004", "general", "0.3"}};
        for (String[] f : fmt) {
            String got = Format.value(Double.parseDouble(f[0]), f[1]);
            if (!got.equals(f[2])) {
                failures++;
                System.out.println("  format(" + f[0] + ", " + f[1] + "): expected " + f[2] + ", got " + got);
            }
        }
    }
}
