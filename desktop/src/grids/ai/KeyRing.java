package grids.ai;

import grids.json.Json;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Desktop twin of web/lib/keyring.js: several AI connections (API keys and subscriptions)
 * in one local .env, with per-connection daily usage so the user (or "auto") can switch
 * as they get used up. Same file format and usage file as the web server — see
 * shared/KEYS.md — so both apps share one key file when run from the repo.
 *
 * Usage lives in .grids-usage.json beside the .env: names and counts only, never keys.
 * The .env is re-read on every call, so hand edits apply without a restart.
 */
public final class KeyRing {
    public static final String DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
    public static final String DEFAULT_MODEL = "openai/gpt-oss-120b";
    private static final List<String> SUFFIXES = List.of("_LIMIT", "_BASE_URL", "_MODEL", "_BIN");
    private static final Pattern NAME_RE = Pattern.compile("[A-Z0-9_]{1,32}");
    private static final Pattern LINE_RE = Pattern.compile("^(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)$");
    private static final long RATE_LIMIT_COOLDOWN_MS = 60_000;
    private static final long AUTH_COOLDOWN_MS = 60 * 60_000;
    private static final String HEADER = "# Grids AI keys — local only, never commit or share this file. See shared/KEYS.md.";
    private static final List<String> SYNC_DIRS = List.of("onedrive", "dropbox", "google drive", "googledrive", "icloud drive", "iclouddrive",
            "mobile documents", "box sync", "pcloud");
    // Key-shaped strings providers sometimes echo back in error messages (same list as keyring.js)
    private static final List<Pattern> KEY_PATTERNS = List.of(
            Pattern.compile("\\b(?:sk|gsk|xai|pk|rk)[-_][A-Za-z0-9_-]{8,}"),
            Pattern.compile("\\bAIza[0-9A-Za-z_-]{20,}"),
            Pattern.compile("(?i)\\bBearer\\s+[A-Za-z0-9._~+/-]{8,}=*"));

    /** Where the key file is and whether it is somewhere risky. Never includes contents. */
    public record FileInfo(Path path, boolean exists, String location, boolean synced, Path homePath) {}

    /** One connection. type is "key" (apiKey/baseUrl set) or "sub" (kind/bin set). limit null = none. */
    public record Conn(String name, String type, String apiKey, String baseUrl, String model, String kind, String bin, Integer limit) {
        public boolean isSub() {
            return "sub".equals(type);
        }
    }

    /** What the UI shows. Never contains the key itself. */
    public record View(String name, String type, String label, Boolean installed, String model, int limit, long requests, long tokens,
                       long rateLimited, long coolingFor, String lastError, boolean available, String hint,
                       String kind, String configLimit, String configBaseUrl, String configModel, boolean editable) {}

    /** Bad input or an unusable choice; status mirrors the web API's HTTP status. */
    public static final class KeyException extends RuntimeException {
        public final int status;

        public KeyException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private final Map<String, String> env;
    private final LongSupplier now;
    private final boolean allowSubs;
    public final Path path;
    private final Path usagePath;
    private String day;
    private Map<String, Map<String, Object>> usage;

    public KeyRing() {
        this(System.getenv(), System::currentTimeMillis, true);
    }

    public KeyRing(Map<String, String> env, LongSupplier now, boolean allowSubs) {
        this.env = env;
        this.now = now;
        this.allowSubs = allowSubs;
        this.path = envFilePath(env);
        this.usagePath = path.resolveSibling(".grids-usage.json");
        loadUsage();
    }

    /**
     * GRIDS_ENV_FILE, else grids/.env in the repo this app runs from (found by walking up
     * from the working dir and the jar to the folder holding shared/FORMAT.md — the same
     * file the web server uses), else ~/.grids/.env for an installed copy.
     */
    public static Path envFilePath(Map<String, String> env) {
        String explicit = env.get("GRIDS_ENV_FILE");
        if (explicit != null && !explicit.isBlank()) return Path.of(explicit);
        List<Path> starts = new ArrayList<>();
        starts.add(Path.of("").toAbsolutePath());
        try {
            starts.add(Path.of(KeyRing.class.getProtectionDomain().getCodeSource().getLocation().toURI()));
        } catch (Exception e) {
            // no code source (unusual class loader): the working dir is enough
        }
        Path repo = null;
        for (Path start : starts) {
            for (Path p = start; p != null && repo == null; p = p.getParent()) {
                if (Files.isRegularFile(p.resolve("shared").resolve("FORMAT.md"))) repo = p.resolve(".env");
            }
        }
        // Same order as keyring.js: an existing repo .env, else an existing ~/.grids/.env,
        // else the repo .env (created on first save), else ~/.grids/.env
        Path home = homeEnvPath();
        if (repo != null && Files.isRegularFile(repo)) return repo;
        if (Files.isRegularFile(home)) return home;
        return repo != null ? repo : home;
    }

    public static Path homeEnvPath() {
        return Path.of(System.getProperty("user.home"), ".grids", ".env");
    }

    /** True when the path is inside a cloud-synced folder, where keys would be uploaded. */
    public static boolean inSyncedFolder(String path, Map<String, String> env) {
        String p = path.toLowerCase(Locale.ROOT);
        for (String var : List.of("OneDrive", "OneDriveConsumer", "OneDriveCommercial")) {
            String r = env.get(var);
            if (r == null || r.isBlank()) continue;
            r = r.toLowerCase(Locale.ROOT);
            if (!r.endsWith("\\") && !r.endsWith("/")) r += java.io.File.separator;
            if (p.startsWith(r)) return true;
        }
        for (String seg : p.split("[\\\\/]")) {
            for (String d : SYNC_DIRS) if (seg.equals(d) || seg.startsWith(d + " -") || seg.startsWith(d + "-")) return true;
        }
        return false;
    }

    /** Remove the given secrets and anything key-shaped from text that will be stored or shown. */
    public static String redact(String text, List<String> secrets) {
        String s = text == null ? "" : text;
        for (String k : secrets) if (k != null && k.length() >= 6) s = s.replace(k, "[redacted]");
        for (Pattern re : KEY_PATTERNS) s = re.matcher(s).replaceAll("[redacted]");
        return s;
    }

    /**
     * Make a file readable by its owner only: mode 600 on POSIX; on Windows an ACL with one
     * entry for the owner and no inherited entries (chmod means nothing there).
     */
    public static boolean secureFile(Path p) {
        try {
            if (Files.getFileAttributeView(p, PosixFileAttributeView.class) != null) {
                Files.setPosixFilePermissions(p, PosixFilePermissions.fromString("rw-------"));
                return true;
            }
            AclFileAttributeView acl = Files.getFileAttributeView(p, AclFileAttributeView.class);
            if (acl == null) return false;
            AclEntry owner = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(acl.getOwner())
                    .setPermissions(EnumSet.allOf(AclEntryPermission.class)).build();
            acl.setAcl(List.of(owner));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    public FileInfo fileInfo() {
        Path home = homeEnvPath();
        String explicit = env.get("GRIDS_ENV_FILE");
        String location = explicit != null && !explicit.isBlank() ? "custom" : path.toAbsolutePath().equals(home.toAbsolutePath()) ? "home" : "repo";
        return new FileInfo(path, Files.isRegularFile(path), location, inSyncedFolder(path.toAbsolutePath().toString(), env), home);
    }

    /** Re-apply owner-only permissions to an existing key file (called at startup). */
    public boolean secure() {
        return Files.isRegularFile(path) && secureFile(path);
    }

    /** Minimal .env parser: KEY=VALUE, `export `, quotes, # comments. Same rules as parseEnv in keyring.js. */
    public static Map<String, String> parseEnv(String text) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String raw : text.split("\\r?\\n")) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) continue;
            Matcher m = LINE_RE.matcher(line);
            if (!m.matches()) continue;
            String v = m.group(2);
            if (v.length() >= 2 && ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'")))) v = v.substring(1, v.length() - 1);
            else v = v.replaceAll("\\s+#.*$", "").strip();
            out.put(m.group(1), v);
        }
        return out;
    }

    public static boolean validName(String name) {
        return name != null && NAME_RE.matcher(name).matches() && SUFFIXES.stream().noneMatch(name::endsWith) && !name.equals("SELECT");
    }

    /** Environment overlaid with the .env file (file wins: it's what the user just edited). */
    public Map<String, String> vars() {
        Map<String, String> v = new LinkedHashMap<>(env);
        try {
            v.putAll(parseEnv(Files.readString(path, StandardCharsets.UTF_8)));
        } catch (IOException e) {
            // no .env yet
        }
        return v;
    }

    private static Integer limitOf(String s) {
        if (s == null) return null;
        try {
            double d = Double.parseDouble(s.strip());
            return d >= 1 && Double.isFinite(d) ? (int) Math.min(Math.floor(d), Integer.MAX_VALUE) : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String trimSlash(String url) {
        return url.replaceAll("/+$", "");
    }

    static boolean isLocalUrl(String url) {
        try {
            String h = URI.create(url).getHost();
            return "localhost".equals(h) || "127.0.0.1".equals(h) || "[::1]".equals(h) || "::1".equals(h);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    public List<Conn> keys() {
        Map<String, String> v = vars();
        String baseUrl = trimSlash(nonBlank(v.get("AI_BASE_URL"), DEFAULT_BASE_URL));
        String model = nonBlank(v.get("AI_MODEL"), DEFAULT_MODEL);
        List<Conn> keys = new ArrayList<>();
        for (Map.Entry<String, String> e : v.entrySet()) {
            String k = e.getKey();
            String type = k.startsWith("AI_KEY_") ? "key" : k.startsWith("AI_SUB_") ? "sub" : null;
            if (type == null) continue;
            String name = k.substring(7);
            String val = e.getValue();
            if (!validName(name) || val == null || val.isEmpty() || keys.stream().anyMatch(x -> x.name().equals(name))) continue;
            Integer limit = limitOf(v.get(k + "_LIMIT"));
            if (type.equals("key")) {
                keys.add(new Conn(name, type, val, trimSlash(nonBlank(v.get(k + "_BASE_URL"), baseUrl)), nonBlank(v.get(k + "_MODEL"), model), null, null, limit));
            } else if (Subscriptions.KINDS.containsKey(val.toLowerCase())) {
                String m = nonBlank(v.get(k + "_MODEL"), "");
                keys.add(new Conn(name, type, null, null, Subscriptions.validModel(m) ? m : "", val.toLowerCase(), nonBlank(v.get(k + "_BIN"), ""), limit));
            }
        }
        String legacy = v.get("AI_API_KEY");
        if (legacy != null && !legacy.isEmpty() && keys.stream().noneMatch(c -> c.name().equals("DEFAULT"))) {
            keys.add(0, new Conn("DEFAULT", "key", legacy, baseUrl, model, null, null, null));
        }
        // A keyless local provider (Ollama, LM Studio) still counts as usable
        if (keys.isEmpty() && isLocalUrl(baseUrl)) keys.add(new Conn("LOCAL", "key", "", baseUrl, model, null, null, null));
        return keys;
    }

    private static String nonBlank(String s, String fallback) {
        return s == null || s.isEmpty() ? fallback : s;
    }

    public String defaultSelection() {
        return nonBlank(vars().get("AI_KEY_SELECT"), "auto");
    }

    // ---------- usage ----------

    private String today() {
        return Instant.ofEpochMilli(now.getAsLong()).toString().substring(0, 10);
    }

    @SuppressWarnings("unchecked")
    private void loadUsage() {
        day = today();
        usage = new LinkedHashMap<>();
        try {
            if (Json.parse(Files.readString(usagePath, StandardCharsets.UTF_8)) instanceof Map<?, ?> u && u.get("keys") instanceof Map<?, ?> ks) {
                if (u.get("day") instanceof String d) day = d;
                for (Map.Entry<?, ?> e : ks.entrySet()) {
                    if (e.getValue() instanceof Map<?, ?> m) usage.put(String.valueOf(e.getKey()), new LinkedHashMap<>((Map<String, Object>) m));
                }
            }
        } catch (IOException | IllegalArgumentException e) {
            // missing or corrupt: start fresh
        }
    }

    private void rollDay() {
        String t = today();
        if (t.equals(day)) return;
        // Counts reset daily; cooldowns survive (they're absolute timestamps)
        for (Map<String, Object> s : usage.values()) {
            s.put("requests", 0);
            s.put("tokens", 0);
            s.put("rateLimited", 0);
        }
        day = t;
    }

    private static long num(Map<String, Object> s, String k) {
        return s != null && s.get(k) instanceof Number n ? n.longValue() : 0;
    }

    private Map<String, Object> stats(String name) {
        rollDay();
        return usage.get(name);
    }

    public long requestsToday(String name) {
        return num(stats(name), "requests");
    }

    private void save() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("day", day);
        out.put("keys", usage);
        try {
            Files.createDirectories(usagePath.getParent());
            Path tmp = usagePath.resolveSibling(".grids-usage.json.tmp");
            Files.writeString(tmp, Json.pretty(out), StandardCharsets.UTF_8);
            Files.move(tmp, usagePath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            // read-only location: usage stays in memory for this run
        }
    }

    public boolean available(Conn k) {
        if (k.isSub() && !allowSubs) return false;
        Map<String, Object> s = stats(k.name());
        return num(s, "cooldownUntil") <= now.getAsLong() && (k.limit() == null || num(s, "requests") < k.limit());
    }

    /** Fraction of the day's budget used; unlimited connections rank by raw count. */
    private double score(Conn k) {
        long r = requestsToday(k.name());
        return k.limit() != null ? (double) r / k.limit() : r / 10_000.0;
    }

    /**
     * Connections to try, in order. A named selection is just that one (no silent
     * switching), and it still respects its daily limit. "auto" = every available one,
     * most headroom first, file order on ties.
     */
    public List<Conn> candidates(String selection) {
        List<Conn> keys = keys();
        String sel = selection == null || selection.isBlank() ? defaultSelection() : selection;
        if (!sel.equals("auto")) {
            Conn k = keys.stream().filter(c -> c.name().equals(sel)).findFirst()
                    .orElseThrow(() -> new KeyException(400, "No AI connection named " + sel + " in " + path + "."));
            if (k.isSub() && !allowSubs) throw new KeyException(403, "Subscriptions are turned off.");
            if (k.limit() != null && requestsToday(k.name()) >= k.limit()) {
                throw new KeyException(429, k.name() + " has used its " + k.limit() + " requests for today. Pick Auto or another connection, or raise its limit.");
            }
            return List.of(k);
        }
        List<Conn> ok = new ArrayList<>();
        for (Conn k : keys) if (available(k)) ok.add(k);
        List<Conn> order = new ArrayList<>(ok);
        order.sort(Comparator.comparingDouble(this::score).thenComparingInt(ok::indexOf));
        return order;
    }

    public void record(String name, boolean ok, int status, long tokens, long retryAfterS, String error) {
        rollDay();
        Map<String, Object> s = usage.computeIfAbsent(name, n -> new LinkedHashMap<>());
        s.put("requests", num(s, "requests") + 1);
        s.put("total", num(s, "total") + 1);
        s.put("tokens", num(s, "tokens") + Math.max(0, tokens));
        s.putIfAbsent("rateLimited", 0);
        s.putIfAbsent("cooldownUntil", 0);
        s.put("lastUsed", Instant.ofEpochMilli(now.getAsLong()).toString());
        if (ok) s.put("lastError", "");
        else {
            String err = redact(error, keys().stream().map(Conn::apiKey).toList());
            s.put("lastError", err.length() > 200 ? err.substring(0, 200) : err);
            if (status == 429) {
                s.put("rateLimited", num(s, "rateLimited") + 1);
                s.put("cooldownUntil", now.getAsLong() + (retryAfterS > 0 ? Math.min(retryAfterS, 3600) * 1000 : RATE_LIMIT_COOLDOWN_MS));
            } else if (status == 401 || status == 402 || status == 403) {
                s.put("cooldownUntil", now.getAsLong() + AUTH_COOLDOWN_MS); // bad key / out of credit
            }
        }
        save();
    }

    public List<View> summary() {
        List<View> out = new ArrayList<>();
        Map<String, String> v = vars();
        for (Conn k : keys()) {
            String prefix = (k.isSub() ? "AI_SUB_" : "AI_KEY_") + k.name();
            Map<String, Object> s = stats(k.name());
            Subscriptions.Kind sub = k.isSub() ? Subscriptions.KINDS.get(k.kind()) : null;
            String host = "";
            if (!k.isSub()) {
                try {
                    URI u = URI.create(k.baseUrl());
                    host = u.getHost() == null ? "" : u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
                } catch (IllegalArgumentException e) {
                    // leave blank
                }
            }
            String hint = sub != null ? "subscription" : k.apiKey().isEmpty() ? "(none)" : "…" + k.apiKey().substring(Math.max(0, k.apiKey().length() - 4));
            out.add(new View(k.name(), k.type(), sub != null ? sub.label() : host,
                    sub != null ? (!k.bin().isEmpty() || Subscriptions.detect(sub.bin()) != null) : null,
                    !k.model().isEmpty() ? k.model() : sub != null ? "(CLI default)" : "",
                    k.limit() == null ? 0 : k.limit(), num(s, "requests"), num(s, "tokens"), num(s, "rateLimited"),
                    Math.max(0, (long) Math.ceil((num(s, "cooldownUntil") - now.getAsLong()) / 1000.0)),
                    s != null && s.get("lastError") instanceof String le ? le : "", available(k), hint,
                    k.kind() == null ? "" : k.kind(), v.getOrDefault(prefix + "_LIMIT", ""),
                    k.isSub() ? "" : v.getOrDefault(prefix + "_BASE_URL", ""), v.getOrDefault(prefix + "_MODEL", ""),
                    !"LOCAL".equals(k.name()) && !"DEFAULT".equals(k.name())));
        }
        return out;
    }

    // ---------- editing the .env ----------

    private interface Mutation {
        List<String> apply(List<String> lines);
    }

    private void rewrite(Mutation m) {
        List<String> lines = new ArrayList<>();
        try {
            lines.addAll(Arrays.asList(Files.readString(path, StandardCharsets.UTF_8).split("\\r?\\n", -1)));
        } catch (IOException e) {
            // new file
        }
        if (!lines.isEmpty() && lines.get(lines.size() - 1).isEmpty()) lines.remove(lines.size() - 1);
        lines = m.apply(lines);
        try {
            Files.createDirectories(path.toAbsolutePath().getParent());
            if (lines.stream().allMatch(String::isBlank)) lines.add(0, HEADER);
            Path tmp = path.resolveSibling(path.getFileName() + "." + ProcessHandle.current().pid() + ".tmp");
            Files.deleteIfExists(tmp); // a stale temp file would keep its old permissions
            Files.writeString(tmp, String.join("\n", lines) + "\n", StandardCharsets.UTF_8);
            try {
                Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------"));
            } catch (UnsupportedOperationException | IOException e) {
                // Windows: the file inherits the user-profile ACL
            }
            Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            secureFile(path); // Windows: the moved file carries the folder's inherited ACL
        } catch (IOException e) {
            throw new KeyException(500, "Could not write " + path + ": " + e.getMessage());
        }
    }

    private static String clean(String v, int max) {
        String s = v == null ? "" : v.strip();
        if (s.indexOf('\r') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('"') >= 0) throw new KeyException(400, "Values cannot contain newlines or quotes.");
        return s.length() > max ? s.substring(0, max) : s;
    }

    private static Integer parseLimit(String limit) {
        if (limit == null || limit.isBlank()) return null;
        try {
            double d = Double.parseDouble(limit.strip());
            if (d >= 1 && Double.isFinite(d)) return (int) Math.min(Math.floor(d), Integer.MAX_VALUE);
        } catch (NumberFormatException e) {
            // fall through
        }
        throw new KeyException(400, "Limit must be a positive whole number.");
    }

    private static String newName(String name) {
        String n = name == null ? "" : name.strip().toUpperCase();
        if (!validName(n) || n.equals("DEFAULT") || n.equals("LOCAL")) {
            throw new KeyException(400, "Name must be 1–32 of A–Z, 0–9, _ (and not end in _LIMIT/_MODEL/_BASE_URL).");
        }
        return n;
    }

    /** "key", "sub", or null for a name not in the .env. */
    private String existing(String name) {
        Map<String, String> v = vars();
        if (!v.getOrDefault("AI_KEY_" + name, "").isEmpty()) return "key";
        if (!v.getOrDefault("AI_SUB_" + name, "").isEmpty()) return "sub";
        return null;
    }

    /** Add a new API key. A name that is already used is refused, so nothing is overwritten by accident. */
    public String addKey(String name, String apiKey, String limit, String baseUrl, String model) {
        String n = newName(name);
        String key = clean(apiKey, 500);
        if (key.isEmpty()) throw new KeyException(400, "API key is empty.");
        String url = checkUrl(baseUrl);
        Integer lim = parseLimit(limit);
        String mdl = clean(model, 200);
        if (existing(n) != null) throw new KeyException(409, n + " already exists. Edit it, or pick another name.");
        writeKey(n, key, lim, url, mdl);
        return n;
    }

    /** Change an API key's settings. An empty apiKey keeps the stored key. */
    public String updateKey(String name, String apiKey, String limit, String baseUrl, String model) {
        String n = newName(name);
        if (!"key".equals(existing(n))) throw new KeyException(404, "There is no API key called " + n + ".");
        String typed = clean(apiKey, 500);
        String key = typed.isEmpty() ? vars().get("AI_KEY_" + n) : typed;
        String url = checkUrl(baseUrl);
        Integer lim = parseLimit(limit);
        String mdl = clean(model, 200);
        writeKey(n, key, lim, url, mdl);
        if (!typed.isEmpty() && usage.get(n) != null) { // a new key deserves a fresh try
            usage.get(n).put("cooldownUntil", 0);
            usage.get(n).put("lastError", "");
            save();
        }
        return n;
    }

    private void writeKey(String n, String key, Integer lim, String url, String mdl) {
        rewrite(lines -> {
            List<String> kept = without(lines, n);
            kept.add("AI_KEY_" + n + "=\"" + key + "\"");
            if (lim != null) kept.add("AI_KEY_" + n + "_LIMIT=" + lim);
            if (!url.isEmpty()) kept.add("AI_KEY_" + n + "_BASE_URL=" + url);
            if (!mdl.isEmpty()) kept.add("AI_KEY_" + n + "_MODEL=" + mdl);
            return kept;
        });
    }

    private static String checkUrl(String baseUrl) {
        String url = clean(baseUrl, 300);
        if (!url.isEmpty()) {
            URI u;
            try {
                u = URI.create(url);
            } catch (IllegalArgumentException e) {
                throw new KeyException(400, "Base URL is not a valid URL.");
            }
            boolean https = "https".equals(u.getScheme()) && u.getHost() != null;
            if (!https && !("http".equals(u.getScheme()) && isLocalUrl(url))) throw new KeyException(400, "Base URL must be https (or http on localhost).");
        }
        return url;
    }

    private static String subModel(String kind, String model) {
        if (kind == null || !Subscriptions.KINDS.containsKey(kind)) throw new KeyException(400, "Type must be one of " + String.join(", ", Subscriptions.KINDS.keySet()) + ".");
        String mdl = model == null ? "" : model.strip();
        if (!Subscriptions.validModel(mdl)) throw new KeyException(400, "Model may only contain letters, digits and . _ : / -");
        return mdl;
    }

    private void writeSub(String n, String kind, Integer lim, String mdl, String bin) {
        rewrite(lines -> {
            List<String> kept = without(lines, n);
            kept.add("AI_SUB_" + n + "=" + kind);
            if (lim != null) kept.add("AI_SUB_" + n + "_LIMIT=" + lim);
            if (!mdl.isEmpty()) kept.add("AI_SUB_" + n + "_MODEL=" + mdl);
            if (!bin.isEmpty()) kept.add("AI_SUB_" + n + "_BIN=" + bin);
            return kept;
        });
    }

    /** Subscriptions: the CLI type, a name, limit and model. The CLI path (_BIN) stays hand-edited. */
    public String addSubscription(String name, String kind, String limit, String model) {
        String n = newName(name);
        String mdl = subModel(kind, model);
        Integer lim = parseLimit(limit);
        if (existing(n) != null) throw new KeyException(409, n + " already exists. Edit it, or pick another name.");
        writeSub(n, kind, lim, mdl, "");
        return n;
    }

    /** Change a subscription's type, limit or model. A hand-set _BIN line is kept. */
    public String updateSubscription(String name, String kind, String limit, String model) {
        String n = newName(name);
        if (!"sub".equals(existing(n))) throw new KeyException(404, "There is no subscription called " + n + ".");
        Map<String, String> v = vars();
        String k = kind == null || kind.isBlank() ? v.get("AI_SUB_" + n).toLowerCase(Locale.ROOT) : kind;
        String mdl = subModel(k, model);
        Integer lim = parseLimit(limit);
        writeSub(n, k, lim, mdl, clean(v.getOrDefault("AI_SUB_" + n + "_BIN", ""), 500));
        return n;
    }

    public void removeKey(String name) {
        if ("DEFAULT".equals(name)) {
            Pattern legacy = Pattern.compile("^\\s*(?:export\\s+)?AI_API_KEY\\s*=.*");
            rewrite(lines -> new ArrayList<>(lines.stream().filter(l -> !legacy.matcher(l).matches()).toList()));
        } else {
            if (!validName(name)) throw new KeyException(400, "Bad key name.");
            if (existing(name) == null) throw new KeyException(404, "There is nothing called " + name + ".");
            boolean selected = name.equals(vars().get("AI_KEY_SELECT"));
            Pattern sel = Pattern.compile("^\\s*(?:export\\s+)?AI_KEY_SELECT\\s*=.*");
            rewrite(lines -> {
                List<String> kept = without(lines, name);
                if (!selected) return kept;
                // A default that points at nothing would silently fall back; say so explicitly
                List<String> out = new ArrayList<>(kept.stream().filter(l -> !sel.matcher(l).matches()).toList());
                out.add("AI_KEY_SELECT=auto");
                return out;
            });
        }
        usage.remove(name);
        save();
    }

    public void setSelection(String sel) {
        if (!"auto".equals(sel) && !validName(sel)) throw new KeyException(400, "Bad selection.");
        Pattern p = Pattern.compile("^\\s*(?:export\\s+)?AI_KEY_SELECT\\s*=.*");
        rewrite(lines -> {
            List<String> kept = new ArrayList<>(lines.stream().filter(l -> !p.matcher(l).matches()).toList());
            kept.add("AI_KEY_SELECT=" + sel);
            return kept;
        });
    }

    private static List<String> without(List<String> lines, String name) {
        Pattern re = Pattern.compile("^\\s*(?:export\\s+)?AI_(?:KEY|SUB)_" + Pattern.quote(name) + "(?:_LIMIT|_BASE_URL|_MODEL|_BIN)?\\s*=.*");
        return new ArrayList<>(lines.stream().filter(l -> !re.matcher(l).matches()).toList());
    }
}
