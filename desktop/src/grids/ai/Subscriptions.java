package grids.ai;

import grids.json.Json;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Desktop twin of web/lib/subscriptions.js. Uses an AI plan the user already pays for
 * (Claude Pro/Max, ChatGPT Plus/Pro, Google AI) through that vendor's own official CLI,
 * signed in with the user's account. Grids only runs the CLI and reads its answer; it
 * never reads or reuses the CLI's login tokens.
 *
 * CLIs have no function calling, so the model answers in the JSON text protocol from
 * shared/ai/text-protocol.md and parseTextReply turns that into the usual actions.
 */
public final class Subscriptions {
    private Subscriptions() {}

    /** Parsed CLI output: the model's text and how many tokens it reported (0 if unknown). */
    public record Output(String text, long tokens) {}

    /** args(model, tempDir) and parse(stdout, tempDir); parse throws IllegalStateException for a CLI-reported error. */
    public record Kind(String label, String bin, String login, BiFunction<String, Path, List<String>> args, BiFunction<String, Path, Output> parse) {}

    /** Result of one run. status follows HTTP: 200 ok, 401 login, 429 limit, 503 missing, 504 timeout, 500 other. */
    public record Result(boolean ok, int status, String text, long tokens, String detail) {}

    private static final Pattern MODEL_RE = Pattern.compile("[A-Za-z0-9._:/-]{1,100}");
    private static final long MAX_OUTPUT = 4L * 1024 * 1024;
    public static final long TIMEOUT_MS = 180_000;

    public static final Map<String, Kind> KINDS = kinds();

    private static Map<String, Kind> kinds() {
        Map<String, Kind> k = new LinkedHashMap<>();
        // No tools: the model only writes the JSON answer. No session saved to disk.
        k.put("claude", new Kind("Claude Pro / Max (Claude Code)", "claude", "Run `claude` once and sign in with your Claude account.",
                (model, dir) -> withModel(List.of("-p", "--output-format", "json", "--tools", "", "--no-session-persistence"), "--model", model),
                (out, dir) -> {
                    if (!(Json.parse(out) instanceof Map<?, ?> j)) throw new IllegalStateException("Claude Code returned no JSON");
                    if (Boolean.TRUE.equals(j.get("is_error"))) throw new IllegalStateException(String.valueOf(j.get("result") != null ? j.get("result") : j.get("subtype")));
                    long tokens = 0;
                    if (j.get("usage") instanceof Map<?, ?> u) {
                        if (u.get("input_tokens") instanceof Number n) tokens += n.longValue();
                        if (u.get("output_tokens") instanceof Number n) tokens += n.longValue();
                    }
                    return new Output(j.get("result") instanceof String s ? s : "", tokens);
                }));
        k.put("codex", new Kind("ChatGPT Plus / Pro (Codex CLI)", "codex", "Run `codex login` and choose \"Sign in with ChatGPT\".",
                (model, dir) -> {
                    List<String> a = new ArrayList<>(List.of("exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", dir.resolve("last.txt").toString()));
                    if (!model.isEmpty()) a.addAll(List.of("--model", model));
                    a.add("-");
                    return a;
                },
                (out, dir) -> {
                    try {
                        return new Output(Files.readString(dir.resolve("last.txt"), StandardCharsets.UTF_8), 0);
                    } catch (IOException e) {
                        return new Output(out, 0);
                    }
                }));
        // -p is appended to stdin; one word so it survives Windows .cmd argument handling
        k.put("gemini", new Kind("Google AI / Gemini (Gemini CLI)", "gemini", "Run `gemini` once and choose \"Login with Google\".",
                (model, dir) -> withModel(List.of("-p", "Answer.", "--output-format", "json"), "-m", model),
                (out, dir) -> {
                    Object parsed;
                    try {
                        parsed = Json.parse(out);
                    } catch (IllegalArgumentException e) {
                        return new Output(out, 0); // older CLI: plain text
                    }
                    if (!(parsed instanceof Map<?, ?> j)) return new Output(out, 0);
                    if (j.get("error") != null) {
                        Object er = j.get("error");
                        throw new IllegalStateException(er instanceof Map<?, ?> em && em.get("message") != null ? String.valueOf(em.get("message")) : String.valueOf(er));
                    }
                    long tokens = 0;
                    if (j.get("stats") instanceof Map<?, ?> st && st.get("models") instanceof Map<?, ?> ms) {
                        for (Object m : ms.values()) {
                            if (m instanceof Map<?, ?> mm && mm.get("tokens") instanceof Map<?, ?> t && t.get("total") instanceof Number n) tokens += n.longValue();
                        }
                    }
                    return new Output(j.get("response") instanceof String s ? s : "", tokens);
                }));
        return k;
    }

    private static List<String> withModel(List<String> base, String flag, String model) {
        List<String> a = new ArrayList<>(base);
        if (!model.isEmpty()) a.addAll(List.of(flag, model));
        return a;
    }

    public static boolean validModel(String m) {
        return m == null || m.isEmpty() || MODEL_RE.matcher(m).matches();
    }

    private static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase().startsWith("windows");
    private static final Map<String, Optional<String>> INSTALLED = new ConcurrentHashMap<>();

    /** Full path of the CLI if it's on PATH (cached per run), else null. */
    public static String detect(String bin) {
        return INSTALLED.computeIfAbsent(bin, b -> {
            try {
                Process p = new ProcessBuilder(WINDOWS ? "where" : "which", b).redirectErrorStream(true).start();
                p.getOutputStream().close();
                String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                if (!p.waitFor(5, TimeUnit.SECONDS) || p.exitValue() != 0) return Optional.empty();
                // On Windows `where` also lists extensionless sh shims (npm); only .exe/.cmd/.bat/.com can run
                return out.lines().map(String::strip).filter(l -> !l.isEmpty())
                        .filter(l -> !WINDOWS || l.toLowerCase().matches(".*\\.(exe|cmd|bat|com)$")).findFirst();
            } catch (IOException e) {
                return Optional.empty();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.empty();
            }
        }).orElse(null);
    }

    private static final Pattern LIMIT_RE = Pattern.compile("rate.?limit|usage limit|limit reached|quota|resource_exhausted|\\b429\\b|too many requests|out of (credits|messages)", Pattern.CASE_INSENSITIVE);
    private static final Pattern LOGIN_RE = Pattern.compile("not (logged|signed) in|log ?in required|please (log|sign) ?in|unauthori[sz]ed|\\b401\\b|invalid api key|authenticat|must specify the \\w*API_KEY", Pattern.CASE_INSENSITIVE);

    /** Classify CLI failures so the key ring can fail over (429) or flag a login problem (401). */
    public static int classifyFailure(String text) {
        if (LIMIT_RE.matcher(text).find()) return 429;
        if (LOGIN_RE.matcher(text).find()) return 401;
        return 500;
    }

    /** Text reply: the user-facing message plus raw {name, args} calls (validated later by AiClient). */
    public record TextReply(String reply, List<Object> calls) {}

    private static final Pattern FENCE = Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)```");

    /** Pull the JSON object out of a model's text answer (tolerates fences and stray prose). */
    @SuppressWarnings("unchecked")
    public static TextReply parseTextReply(String text) {
        String s = text == null ? "" : text.strip();
        Matcher f = FENCE.matcher(s);
        if (f.find()) s = f.group(1).strip();
        int start = s.indexOf('{');
        int end = s.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                if (Json.parse(s.substring(start, end + 1)) instanceof Map<?, ?> j) {
                    return new TextReply(j.get("reply") instanceof String r ? r : "", j.get("actions") instanceof List<?> a ? (List<Object>) a : List.of());
                }
            } catch (IllegalArgumentException e) {
                // not JSON: fall through
            }
        }
        return new TextReply(text == null ? "" : text.strip(), List.of());
    }

    /** Run one subscription request. bin may be overridden per connection (AI_SUB_<NAME>_BIN). */
    public static Result run(String kind, String model, String bin, String prompt, long timeoutMs) {
        Kind k = KINDS.get(kind);
        if (k == null) return new Result(false, 400, "", 0, "Unknown subscription type " + kind + ".");
        String mdl = model == null ? "" : model;
        if (!validModel(mdl)) return new Result(false, 400, "", 0, "Bad model name.");
        String exe = bin == null || bin.isEmpty() ? k.bin() : bin;
        Path dir;
        try {
            dir = Files.createTempDirectory("grids-sub-");
        } catch (IOException e) {
            return new Result(false, 500, "", 0, "Could not create a temp folder: " + e.getMessage());
        }
        try {
            return runIn(k, exe, mdl, prompt, timeoutMs, dir);
        } finally {
            try (Stream<Path> walk = Files.walk(dir)) {
                walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            } catch (IOException e) {
                // temp dir cleanup is best effort
            }
        }
    }

    private static Result runIn(Kind k, String exe, String model, String prompt, long timeoutMs, Path dir) {
        // npm-installed CLIs are .cmd shims on Windows and must run through cmd.exe. Every
        // argument is a fixed literal or a validated model name; the prompt goes via stdin.
        String resolved = detect(exe);
        boolean viaCmd = WINDOWS && (resolved != null ? resolved : exe).toLowerCase().matches(".*\\.(cmd|bat)$");
        List<String> cmd = new ArrayList<>();
        if (viaCmd) cmd.addAll(List.of(System.getenv().getOrDefault("ComSpec", "cmd.exe"), "/d", "/s", "/c", exe));
        else cmd.add(resolved != null ? resolved : exe);
        cmd.addAll(k.args().apply(model, dir));

        Path outFile = dir.resolve("stdout.txt");
        Path errFile = dir.resolve("stderr.txt");
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(dir.toFile()) // empty dir: the CLI sees no project files
                .redirectOutput(outFile.toFile()).redirectError(errFile.toFile());
        pb.environment().put("NO_COLOR", "1");
        Process p;
        try {
            p = pb.start();
        } catch (IOException e) {
            return new Result(false, 503, "", 0, exe + " is not installed. " + k.login());
        }
        try (OutputStream in = p.getOutputStream()) {
            in.write(prompt.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // the CLI may exit before reading everything
        }
        try {
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                p.descendants().forEach(ProcessHandle::destroyForcibly); // cmd.exe alone would orphan the CLI
                p.destroyForcibly();
                p.waitFor(5, TimeUnit.SECONDS);
                return new Result(false, 504, "", 0, exe + " timed out after " + timeoutMs / 1000 + "s.");
            }
        } catch (InterruptedException e) {
            p.descendants().forEach(ProcessHandle::destroyForcibly);
            p.destroyForcibly();
            Thread.currentThread().interrupt();
            return new Result(false, 500, "", 0, "Interrupted");
        }
        String out = readCapped(outFile);
        String err = readCapped(errFile);
        try {
            Output o = k.parse().apply(out, dir);
            if (p.exitValue() == 0 && !o.text().isBlank()) return new Result(true, 200, o.text(), o.tokens(), "");
            return fail(k, tail(!o.text().isBlank() ? o.text() : !err.isBlank() ? err : !out.isBlank() ? out : "exited with code " + p.exitValue()));
        } catch (IllegalStateException | IllegalArgumentException e) {
            return fail(k, tail(e.getMessage() + " " + err));
        }
    }

    private static Result fail(Kind k, String why) {
        int status = classifyFailure(why);
        return new Result(false, status, "", 0, k.label() + ": " + why + (status == 401 ? " — " + k.login() : ""));
    }

    private static String tail(String s) {
        String t = s.strip();
        return t.length() > 400 ? t.substring(t.length() - 400) : t;
    }

    private static String readCapped(Path f) {
        try {
            byte[] b = Files.readAllBytes(f);
            return new String(b, 0, (int) Math.min(b.length, MAX_OUTPUT), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }
}
