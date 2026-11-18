package grids.ai;

import grids.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Desktop twin of web/lib/ai.js: one OpenAI-compatible chat-completions call with the
 * shared tools (shared/ai/tools.json) and system prompt. Works with Groq, OpenRouter,
 * OpenAI, Gemini's OpenAI endpoint, Ollama, LM Studio...
 *
 * The desktop app calls providers directly (no server in between). Keys and subscriptions
 * come from the local .env through KeyRing — the same file and format as the web server.
 */
public final class AiClient {
    public record Provider(String baseUrl, String model, String apiKey) {
        public static Provider fromEnv() {
            String base = System.getenv().getOrDefault("AI_BASE_URL", "https://api.groq.com/openai/v1");
            String model = System.getenv().getOrDefault("AI_MODEL", "openai/gpt-oss-120b");
            String key = System.getenv().getOrDefault("AI_API_KEY", "");
            return new Provider(base, model, key);
        }

        boolean isLocal() {
            try {
                String h = URI.create(baseUrl).getHost();
                return "localhost".equals(h) || "127.0.0.1".equals(h) || "[::1]".equals(h);
            } catch (IllegalArgumentException e) {
                return false;
            }
        }
    }

    public record Action(String name, Map<String, Object> args) {}

    /** key = the connection that answered (null for a direct provider), model = what it reported. */
    public record Reply(String text, List<Action> actions, String key, String model) {
        public Reply(String text, List<Action> actions) {
            this(text, actions, null, null);
        }
    }

    /** One subscription CLI call; swappable so tests don't need a real CLI. */
    public interface SubRunner {
        Subscriptions.Result run(String kind, String model, String bin, String prompt);
    }

    /** Statuses where trying the next connection can help (rate limit, bad key, no credit). */
    private static final Set<Integer> FAILOVER = Set.of(401, 402, 403, 429);

    public record Message(String role, String content) {}

    public static final class AiException extends Exception {
        public AiException(String message) {
            super(message);
        }
    }

    private static final int MAX_CONTEXT_CELLS = 2000;
    private static final int MAX_CONTEXT_CHARS = 60_000;
    private static final int MAX_HISTORY = 20;

    private static final List<Object> TOOLS = loadTools();
    private static final String SYSTEM_PROMPT = resource("/grids/shared/ai/system-prompt.md");
    private static final String TEXT_PROTOCOL = resource("/grids/shared/ai/text-protocol.md");

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    private static String resource(String path) {
        try (InputStream in = AiClient.class.getResourceAsStream(path)) {
            if (in == null) throw new IllegalStateException(path + " missing from the build");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Object> loadTools() {
        return (List<Object>) Json.parse(resource("/grids/shared/ai/tools.json"));
    }

    /** Sheet snapshot: ref -> {input, value(display)}; title; selection. Same text format as the web server. */
    public static String describeSheet(String title, String selection, Map<String, String[]> cells) {
        StringBuilder lines = new StringBuilder();
        int n = 0;
        boolean truncated = false;
        for (Map.Entry<String, String[]> e : cells.entrySet()) {
            if (n >= MAX_CONTEXT_CELLS || lines.length() > MAX_CONTEXT_CHARS) {
                truncated = true;
                break;
            }
            String input = e.getValue()[0];
            if (input.length() > 500) input = input.substring(0, 500);
            String value = e.getValue()[1];
            lines.append(e.getKey()).append(": ").append(Json.write(input));
            if (value != null && !value.equals(input)) lines.append("  → ").append(value.length() > 200 ? value.substring(0, 200) : value);
            lines.append('\n');
            n++;
        }
        return "Workbook title: " + Json.write(title) + "\n"
                + "Selected: " + selection + "\n"
                + "Non-empty cells (" + cells.size() + ")" + (truncated ? " — truncated to the first " + n : "") + ". Format: REF: \"input\" → value\n"
                + (n == 0 ? "(sheet is empty)" : lines.toString().stripTrailing());
    }

    private static List<Message> recent(List<Message> history) {
        List<Message> out = new ArrayList<>();
        for (Message m : history.subList(Math.max(0, history.size() - MAX_HISTORY), history.size())) {
            out.add(new Message(m.role(), m.content().length() > 8000 ? m.content().substring(0, 8000) : m.content()));
        }
        return out;
    }

    /** One prompt for a CLI that has no function calling. Same layout as textPrompt() in web/lib/ai.js. */
    static String textPrompt(List<Message> history, String sheetContext) {
        List<String> parts = new ArrayList<>(List.of(SYSTEM_PROMPT, TEXT_PROTOCOL + Json.write(TOOLS), "Current sheet:\n" + sheetContext, "## Conversation"));
        for (Message m : recent(history)) parts.add(("user".equals(m.role()) ? "User: " : "Assistant: ") + m.content());
        parts.add("");
        parts.add("Reply now with the single JSON object.");
        return String.join("\n\n", parts);
    }

    private static String prepared(List<Action> actions) {
        return actions.isEmpty() ? "(no reply)" : "Prepared " + actions.size() + " change" + (actions.size() == 1 ? "" : "s") + ".";
    }

    /**
     * Ask through the key ring: a named connection, or "auto" (most headroom first,
     * failing over on 401/402/403/429). Usage is recorded for every attempt.
     */
    public Reply ask(KeyRing ring, String selection, List<Message> history, String sheetContext) throws AiException {
        return ask(ring, selection, history, sheetContext, (kind, model, bin, prompt) -> Subscriptions.run(kind, model, bin, prompt, Subscriptions.TIMEOUT_MS));
    }

    public Reply ask(KeyRing ring, String selection, List<Message> history, String sheetContext, SubRunner subs) throws AiException {
        if (history.isEmpty() || !"user".equals(history.get(history.size() - 1).role())) throw new AiException("The last message must be from the user.");
        List<KeyRing.Conn> tries;
        try {
            tries = ring.candidates(selection);
        } catch (KeyRing.KeyException e) {
            throw new AiException(e.getMessage());
        }
        if (tries.isEmpty()) {
            throw new AiException(ring.keys().isEmpty()
                    ? "No AI key or subscription is connected. Open AI → Keys to add one (saved in " + ring.path + ")."
                    : "Every AI connection is used up for today or cooling down after a rate limit. Add one, raise a limit, or wait.");
        }
        String lastError = "AI request failed.";
        for (KeyRing.Conn c : tries) {
            if (c.isSub()) {
                Subscriptions.Result r = subs.run(c.kind(), c.model(), c.bin(), textPrompt(history, sheetContext));
                ring.record(c.name(), r.ok(), r.status(), r.tokens(), 0, r.detail());
                if (r.ok()) {
                    Subscriptions.TextReply t = Subscriptions.parseTextReply(r.text());
                    List<Object> calls = new ArrayList<>();
                    for (Object call : t.calls()) {
                        if (call instanceof Map<?, ?> m) {
                            calls.add(Map.of("function", Map.of("name", String.valueOf(m.get("name")),
                                    "arguments", Json.write(m.get("args") instanceof Map<?, ?> a ? a : Map.of()))));
                        }
                    }
                    List<Action> actions = extractActions(Map.of("tool_calls", calls));
                    return new Reply(t.reply().isBlank() ? prepared(actions) : t.reply().strip(), actions, c.name(), c.model().isEmpty() ? c.kind() : c.model());
                }
                lastError = r.detail();
                if (!FAILOVER.contains(r.status())) break;
                continue;
            }
            Provider p = new Provider(c.baseUrl(), c.model(), c.apiKey());
            if (p.apiKey().isBlank() && !p.isLocal()) {
                lastError = "No API key is set for " + c.name() + ".";
                continue;
            }
            Call r = call(p, history, sheetContext);
            ring.record(c.name(), r.ok(), r.status(), r.tokens(), r.retryAfterS(), r.detail());
            if (r.ok()) return new Reply(r.reply().text(), r.reply().actions(), c.name(), c.model());
            lastError = r.detail();
            if (!FAILOVER.contains(r.status())) break; // a bad request won't succeed on another key
        }
        String tried = tries.size() > 1 ? " (tried " + String.join(", ", tries.stream().map(KeyRing.Conn::name).toList()) + ")" : "";
        throw new AiException(lastError + tried);
    }

    /** Direct call to one provider (no key ring). */
    public Reply ask(Provider p, List<Message> history, String sheetContext) throws AiException {
        if (p.apiKey().isBlank() && !p.isLocal()) {
            throw new AiException("No AI is configured. Open AI → Keys to add a key or subscription.");
        }
        Call r = call(p, history, sheetContext);
        if (!r.ok()) throw new AiException(r.detail());
        return r.reply();
    }

    /** Outcome of one HTTP call; never thrown so the key ring can decide whether to fail over. */
    private record Call(boolean ok, int status, Reply reply, long tokens, long retryAfterS, String detail) {
        static Call failed(int status, long retryAfterS, String detail) {
            return new Call(false, status, null, 0, retryAfterS, detail);
        }
    }

    @SuppressWarnings("unchecked")
    private Call call(Provider p, List<Message> history, String sheetContext) {
        List<Object> messages = new ArrayList<>();
        messages.add(Map.of("role", "system", "content", SYSTEM_PROMPT));
        messages.add(Map.of("role", "system", "content", "Current sheet:\n" + sheetContext));
        for (Message m : recent(history)) messages.add(Map.of("role", m.role(), "content", m.content()));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", p.model());
        body.put("messages", messages);
        body.put("tools", TOOLS);
        body.put("tool_choice", "auto");
        body.put("temperature", 0.2);

        HttpResponse<String> res;
        try {
            HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(p.baseUrl().replaceAll("/+$", "") + "/chat/completions"))
                    .timeout(Duration.ofSeconds(90))
                    .header("content-type", "application/json")
                    .header("user-agent", "grids-desktop/0.1")
                    .POST(HttpRequest.BodyPublishers.ofString(Json.write(body)));
            if (!p.apiKey().isBlank()) req.header("authorization", "Bearer " + p.apiKey());
            res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            return Call.failed(502, 0, "Could not reach the AI provider: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Call.failed(500, 0, "Interrupted");
        } catch (IllegalArgumentException e) {
            return Call.failed(400, 0, "Bad provider URL: " + e.getMessage());
        }
        long retryAfter = 0;
        try {
            retryAfter = Long.parseLong(res.headers().firstValue("retry-after").orElse("0").strip());
        } catch (NumberFormatException e) {
            // an HTTP date: use the default cooldown
        }
        Object data;
        try {
            data = Json.parse(res.body());
        } catch (IllegalArgumentException e) {
            return Call.failed(res.statusCode() / 100 == 2 ? 502 : res.statusCode(), retryAfter, "AI provider returned " + res.statusCode() + " with a non-JSON body.");
        }
        if (res.statusCode() / 100 != 2) {
            String detail = data instanceof Map<?, ?> m && m.get("error") instanceof Map<?, ?> er && er.get("message") instanceof String s ? s : res.body();
            return Call.failed(res.statusCode(), retryAfter, "AI provider returned " + res.statusCode() + ": " + (detail.length() > 300 ? detail.substring(0, 300) : detail));
        }
        Map<String, Object> message = Map.of();
        long tokens = 0;
        if (data instanceof Map<?, ?> m) {
            if (m.get("choices") instanceof List<?> ch && !ch.isEmpty() && ch.get(0) instanceof Map<?, ?> c0 && c0.get("message") instanceof Map<?, ?> msg) {
                message = (Map<String, Object>) msg;
            }
            if (m.get("usage") instanceof Map<?, ?> u && u.get("total_tokens") instanceof Number n) tokens = n.longValue();
        }
        List<Action> actions = extractActions(message);
        String text = message.get("content") instanceof String s && !s.isBlank() ? s.strip() : prepared(actions);
        return new Call(true, res.statusCode(), new Reply(text, actions, null, p.model()), tokens, 0, "");
    }

    @SuppressWarnings("unchecked")
    static List<Action> extractActions(Map<String, Object> message) {
        Set<String> known = new HashSet<>();
        for (Object t : TOOLS) known.add((String) ((Map<String, Object>) ((Map<String, Object>) t).get("function")).get("name"));
        List<Action> out = new ArrayList<>();
        if (!(message.get("tool_calls") instanceof List<?> calls)) return out;
        for (Object c : calls) {
            if (!(c instanceof Map<?, ?> call) || !(call.get("function") instanceof Map<?, ?> fn)) continue;
            if (!(fn.get("name") instanceof String name) || !known.contains(name)) continue;
            try {
                Object args = Json.parse(fn.get("arguments") instanceof String a && !a.isBlank() ? a : "{}");
                if (args instanceof Map<?, ?> am) out.add(new Action(name, (Map<String, Object>) am));
            } catch (IllegalArgumentException e) {
                // broken JSON from the model: skip this call
            }
        }
        return out;
    }
}
