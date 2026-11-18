import grids.ai.AiClient;
import grids.ai.KeyRing;
import grids.ai.Subscriptions;
import grids.app.Document;
import grids.model.CellFormat;
import grids.model.Workbook;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Headless checks for the desktop layer under the UI: .grid round-trip, CSV import safety,
 * the real CPython bridge (incl. reruns when read cells change), the trust gate, and AI
 * action validation. Needs Python on PATH (or GRIDS_PYTHON).
 *
 *   java -cp "build/classes;build/test" DesktopSmoke [aiBaseUrl]
 * With aiBaseUrl (e.g. a local mock provider) it also does an AI round trip.
 */
public final class DesktopSmoke {
    static int failed = 0;
    static final LinkedBlockingQueue<Runnable> ui = new LinkedBlockingQueue<>();

    static boolean throwsStatus(Runnable r, int status) {
        try {
            r.run();
            return false;
        } catch (KeyRing.KeyException e) {
            return e.status == status;
        }
    }

    /** Key ring + subscriptions: same .env/usage rules as web/test/keyring.test.js. */
    static void keyRingChecks() throws Exception {
        Path dir = Files.createTempDirectory("grids-keys-");
        Path env = dir.resolve(".env");
        Files.writeString(env, "# mine\nAI_KEY_A=ka-secret-1\nAI_KEY_A_LIMIT=2\nAI_KEY_B=\"kb-secret-2\"\nAI_KEY_B_LIMIT=100\nAI_SUB_C=claude\nAI_SUB_C_MODEL=haiku\nAI_SUB_BAD=nonsense\nAI_API_KEY=legacy\n");
        AtomicLong clock = new AtomicLong(Instant.parse("2026-11-18T10:00:00Z").toEpochMilli());
        Map<String, String> envVars = Map.of("GRIDS_ENV_FILE", env.toString());
        KeyRing ring = new KeyRing(envVars, clock::get, true);

        List<String> names = ring.keys().stream().map(KeyRing.Conn::name).toList();
        check("ring lists keys, subs and legacy", names.equals(List.of("DEFAULT", "A", "B", "C")), names);
        check("quoted value parsed", ring.keys().get(2).apiKey().equals("kb-secret-2"), ring.keys().get(2));

        ring.record("A", true, 200, 10, 0, "");
        ring.record("A", true, 200, 10, 0, "");
        List<String> auto = ring.candidates("auto").stream().map(KeyRing.Conn::name).toList();
        check("auto skips a key at its limit", !auto.contains("A") && auto.contains("B"), auto);
        check("named key respects its limit (429)", throwsStatus(() -> ring.candidates("A"), 429), "no 429");
        check("unknown name is 400", throwsStatus(() -> ring.candidates("NOPE"), 400), "no 400");
        ring.record("B", false, 429, 0, 30, "slow down");
        check("429 cools B down", !ring.candidates("auto").stream().map(KeyRing.Conn::name).toList().contains("B"), ring.summary());
        check("named pick ignores cooldown", ring.candidates("B").get(0).name().equals("B"), "");

        String usage = Files.readString(dir.resolve(".grids-usage.json"));
        check("usage file has no key material", !usage.contains("secret") && usage.contains("\"A\""), usage);
        KeyRing again = new KeyRing(envVars, clock::get, true);
        check("usage persists across runs", again.requestsToday("A") == 2, again.requestsToday("A"));
        clock.addAndGet(24L * 3600 * 1000);
        check("usage resets the next day", again.requestsToday("A") == 0 && again.candidates("A").size() == 1, again.requestsToday("A"));
        check("summary hides keys", again.summary().stream().noneMatch(v -> v.hint().contains("secret") || v.hint().equals("ka-secret-1")),
                again.summary().get(1).hint());

        // subscriptions through a fake CLI runner: C hits its plan limit, auto fails over
        String json = "Sure!\n```json\n{\"reply\":\"Done.\",\"actions\":[{\"name\":\"set_cells\",\"args\":{\"cells\":[{\"ref\":\"A1\",\"input\":\"5\"}]}},{\"name\":\"rm_rf\",\"args\":{}}]}\n```";
        List<String> prompts = new ArrayList<>();
        AiClient.SubRunner fake = (kind, model, bin, prompt) -> {
            prompts.add(prompt);
            return new Subscriptions.Result(true, 200, json, 42, "");
        };
        List<AiClient.Message> ask = List.of(new AiClient.Message("user", "put 5 in A1"));
        AiClient.Reply r = new AiClient().ask(again, "C", ask, "(sheet is empty)", fake);
        check("subscription text reply -> validated actions", r.text().equals("Done.") && r.actions().size() == 1 && "C".equals(r.key()), r);
        check("subscription prompt carries protocol + tools", prompts.get(0).contains("single JSON object") && prompts.get(0).contains("set_cells")
                && prompts.get(0).endsWith("Reply now with the single JSON object."), prompts.get(0).length());

        Files.writeString(env, "AI_SUB_ONE=claude\nAI_SUB_TWO=gemini\n");
        KeyRing subs = new KeyRing(envVars, clock::get, true);
        List<String> ran = new ArrayList<>();
        AiClient.SubRunner limited = (kind, model, bin, prompt) -> {
            ran.add(kind);
            return kind.equals("claude") ? new Subscriptions.Result(false, 429, "", 0, "usage limit reached") : new Subscriptions.Result(true, 200, json, 5, "");
        };
        AiClient.Reply r2 = new AiClient().ask(subs, "auto", ask, "(sheet is empty)", limited);
        check("auto fails over from a used-up subscription", ran.equals(List.of("claude", "gemini")) && "TWO".equals(r2.key()), ran);
        check("used-up subscription cools down", !subs.summary().get(0).available(), subs.summary().get(0));
        AiClient.SubRunner broken = (kind, model, bin, prompt) -> new Subscriptions.Result(false, 500, "", 0, "boom");
        ran.clear();
        try {
            new AiClient().ask(subs, "TWO", ask, "x", broken);
            check("named failure surfaces", false, "no error");
        } catch (AiClient.AiException e) {
            check("named failure surfaces", e.getMessage().contains("boom"), e.getMessage());
        }
        check("subs off -> unavailable", !new KeyRing(envVars, clock::get, false).summary().get(1).available(), "");

        // editing
        KeyRing ed = new KeyRing(envVars, clock::get, true);
        ed.addKey("groq1", "gsk_test", "500", "", "llama-3.3-70b-versatile");
        ed.addSubscription("mine", "claude", "", "sonnet");
        ed.setSelection("GROQ1");
        ed.removeKey("ONE");
        String text = Files.readString(env);
        check("add/remove/select edit the .env", text.contains("AI_KEY_GROQ1=\"gsk_test\"") && text.contains("AI_KEY_GROQ1_LIMIT=500")
                && text.contains("AI_SUB_MINE=claude") && !text.contains("AI_SUB_ONE") && text.contains("AI_SUB_TWO=gemini")
                && ed.defaultSelection().equals("GROQ1"), text);
        check("newline injection rejected", throwsStatus(() -> ed.addKey("X", "k\nAI_KEY_EVIL=1", "", "", ""), 400), "");
        check("http non-local base URL rejected", throwsStatus(() -> ed.addKey("X", "k", "", "http://example.com/v1", ""), 400), "");
        check("bad model on a subscription rejected", throwsStatus(() -> ed.addSubscription("X", "claude", "", "x; rm -rf /"), 400), "");
        check("reserved name rejected", throwsStatus(() -> ed.addKey("default", "k", "", "", ""), 400), "");
        check("failure classification", Subscriptions.classifyFailure("You've hit your usage limit") == 429
                && Subscriptions.classifyFailure("Please log in first") == 401 && Subscriptions.classifyFailure("segfault") == 500, "");

        // Windows: a .cmd CLI goes through cmd.exe; the empty --tools "" argument must survive
        if (System.getProperty("os.name", "").toLowerCase().startsWith("windows")) {
            Path fakeCli = dir.resolve("fakeclaude.cmd");
            Files.writeString(fakeCli, "@echo off\r\necho %*> \"%~dp0args.txt\"\r\nmore > nul\r\necho {\"result\":\"{\\\"reply\\\":\\\"hi\\\",\\\"actions\\\":[]}\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\r\n");
            Subscriptions.Result sr = Subscriptions.run("claude", "haiku", fakeCli.toString(), "hello", 20_000);
            String argLine = Files.exists(dir.resolve("args.txt")) ? Files.readString(dir.resolve("args.txt")).strip() : "(none)";
            check(".cmd CLI runs and parses", sr.ok() && sr.tokens() == 7 && sr.text().contains("hi"), sr);
            check(".cmd keeps the empty --tools arg", argLine.contains("--tools \"\" --no-session-persistence --model haiku"), argLine);
        }
        if ("1".equals(System.getenv("GRIDS_LIVE_SUB"))) {
            Subscriptions.Result live = Subscriptions.run("claude", "haiku", "", "Reply with exactly: {\"reply\":\"pong\",\"actions\":[]}", 120_000);
            check("live Claude subscription", live.ok() && Subscriptions.parseTextReply(live.text()).reply().contains("pong"), live);
        }
    }

    static void check(String name, boolean ok, Object detail) {
        System.out.println((ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  -> " + detail));
        if (!ok) failed++;
    }

    /** Pump the fake UI thread until cond holds (or time out). */
    static boolean await(Supplier<Boolean> cond, long seconds) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (!cond.get()) {
            long left = end - System.nanoTime();
            if (left <= 0) return false;
            Runnable r = ui.poll(Math.min(left, TimeUnit.MILLISECONDS.toNanos(200)), TimeUnit.NANOSECONDS);
            if (r != null) r.run();
        }
        return true;
    }

    public static void main(String[] args) throws Exception {
        // .grid round trip with sanitising
        Workbook w = new Workbook();
        w.title = "T";
        w.setInput("A1", "5");
        w.setInput("B2", "=A1*2");
        w.formats.put("A1", CellFormat.fromMap(Map.of("bold", true, "numFmt", "0.00", "bg", "#ABCDEF")));
        w.colWidths.put("B", 9999);
        Workbook back = Workbook.fromJson(w.toJson());
        check("round trip cells", back.cells.equals(w.cells), back.cells);
        check("round trip format", back.formats.get("A1").equals(new CellFormat(true, null, null, "0.00", "#abcdef", null)), back.formats);
        check("width clamped on load", back.colWidths.get("B") == 600, back.colWidths);
        Workbook hostile = Workbook.fromJson("{\"format\":\"grids\",\"version\":1,\"sheets\":[{\"cells\":{\"a1\":\"x\",\"../evil\":\"y\",\"B1\":42},"
                + "\"formats\":{\"A1\":{\"bg\":\"red;}\",\"align\":\"middle\",\"bold\":\"yes\"}}}]}");
        check("bad keys/values dropped", hostile.cells.equals(Map.of("A1", "x")), hostile.cells);
        check("bad formats dropped", hostile.formats.isEmpty(), hostile.formats);
        Workbook csv = Workbook.fromCsv("c", "a,\"b,1\"\n=py import os,3\n");
        check("csv quoted field", "b,1".equals(csv.cells.get("B1")), csv.cells);
        check("csv '=' imports as text", "'=py import os".equals(csv.cells.get("A2")), csv.cells);

        // Python through the real interpreter
        Document doc = new Document(ui::add);
        doc.setInput("A1", "5");
        doc.setInput("B1", "=py cell('A1') * 2");
        doc.setInput("C1", "=B1+1");
        check("python result", await(() -> Double.valueOf(10).equals(doc.value("B1")), 90), doc.value("B1"));
        check("formula reads python", Double.valueOf(11).equals(doc.value("C1")), doc.value("C1"));
        doc.setInput("A1", "7");
        check("rerun when a read cell changes", await(() -> Double.valueOf(14).equals(doc.value("B1")), 30), doc.value("B1"));
        doc.setInput("D1", "=py\nimport math\nxs = [math.sqrt(i) for i in range(1, 4)]\n[[round(x, 3)] for x in xs]");
        check("python spill", await(() -> Double.valueOf(1.732).equals(doc.value("D3")), 30), doc.values);
        doc.setInput("E1", "=py 1/0");
        check("python error", await(() -> doc.value("E1") instanceof grids.engine.GridError e && e.code().equals("#PYTHON!")
                && e.message().contains("ZeroDivisionError"), 30), doc.value("E1"));
        doc.setInput("F1", "=py\nwhile True: pass");
        check("runaway cell times out", await(() -> doc.value("F1") instanceof grids.engine.GridError e && e.message().contains("Timed out"), 40), doc.value("F1"));
        doc.setInput("G1", "=py cell('A1') + 100");
        check("restarts after timeout", await(() -> Double.valueOf(107).equals(doc.value("G1")), 60), doc.value("G1"));

        // Trust gate: an opened file never runs Python until enabled
        Workbook opened = new Workbook();
        opened.setInput("A1", "=py 40 + 2");
        doc.replace(opened, null, false);
        await(() -> false, 2);
        check("untrusted file: python not run", !Double.valueOf(42).equals(doc.value("A1")), doc.value("A1"));
        doc.runAllPython();
        check("enabled: python runs", await(() -> Double.valueOf(42).equals(doc.value("A1")), 30), doc.value("A1"));

        // AI action validation + undo as one step
        doc.replace(new Workbook(), null, true);
        List<String> problems = doc.applyActions(List.of(
                new AiClient.Action("set_cells", Map.of("cells", List.of(Map.of("ref", "A1", "input", "3"), Map.of("ref", "nope", "input", "x")))),
                new AiClient.Action("set_column_width", Map.of("column", "a", "width", 5.0)),
                new AiClient.Action("format_range", Map.of("range", "A1", "bg", "javascript:")),
                new AiClient.Action("rm_rf", Map.of())));
        check("valid actions applied", "3".equals(doc.input("A1")) && doc.wb.colWidths.get("A") == 40, doc.wb.cells);
        check("invalid actions reported", problems.size() == 2, problems);
        check("bad colour ignored", doc.format("A1").bg() == null, doc.format("A1"));
        doc.undo();
        check("AI change is one undo step", doc.wb.cells.isEmpty() && doc.wb.colWidths.isEmpty(), doc.wb.cells);

        if (args.length > 0) {
            AiClient.Reply reply = new AiClient().ask(new AiClient.Provider(args[0], "mock-model", ""),
                    List.of(new AiClient.Message("user", "make a budget")), AiClient.describeSheet(doc.wb.title, "A1", doc.aiSnapshot()));
            check("AI reply parsed", reply.actions().size() == 4, reply);
            doc.applyActions(reply.actions());
            check("AI changes applied", "Budget".equals(doc.wb.title) && "$1,650.50".equals(doc.display("I4")), doc.display("I4"));
        }

        keyRingChecks();
        doc.close();
        System.out.println(failed == 0 ? "\nAll desktop smoke checks passed." : "\n" + failed + " check(s) failed.");
        System.exit(failed == 0 ? 0 : 1);
    }
}
